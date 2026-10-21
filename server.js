'use strict';
const http = require('http');
const fs = require('fs');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT || 18230);
const PROJECT = process.env.GCP_PROJECT || '';
const LOC = process.env.GCP_LOCATION || 'global';
const AUTH = process.env.PROXY_TOKEN || '';
const ADC = process.env.ADC_PATH || (process.env.HOME || '/root') + '/.config/gcloud/application_default_credentials.json';

// --- 429/503 退避重试参数（2026-10-20 新增，可用环境变量覆盖）---
const RETRY_MAX = Number(process.env.RETRY_MAX || 3);        // 额外重试次数（总尝试 = RETRY_MAX + 1）
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 800);
const RETRY_CAP_MS = Number(process.env.RETRY_CAP_MS || 8000); // 单次退避上限
const RETRY_ON = new Set([429, 503]);
// 仅用于自测：把上游指向本地 mock（生产留空）
const UPSTREAM_OVERRIDE = process.env.UPSTREAM_OVERRIDE || '';

// --- 上游首字节超时（2026-10-21 新增）---
// 流式的首字节 = 首个 token，历史 p50 6.7s / p90 31.6s，45s 足够宽松；
// 非流式的首字节 = 全文生成完，必须给足时间（历史见过 82s）。
// 上游挂死时不再无限等待：超时即返回 504，让客户端立刻失败而不是干等两分钟。
const TTFB_STREAM_MS = Number(process.env.TTFB_STREAM_MS || 45000);
const TTFB_NONSTREAM_MS = Number(process.env.TTFB_NONSTREAM_MS || 120000);

const MODELS = [
  'google/gemini-4-argon',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite'
];

let cache = { v: '', exp: 0 };

function kv(o) {
  return Object.keys(o).map(function (k) { return k + '=' + o[k]; }).join(' ');
}
function log(tag, o) {
  console.log('[%s] %s %s', tag, new Date().toISOString(), kv(o));
}
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
function short(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
// truncated exponential backoff + jitter；上游给 Retry-After 时优先服从
function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, RETRY_CAP_MS);
  const exp = RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(Math.round(exp * jitter), RETRY_CAP_MS);
}

function readADC() {
  return JSON.parse(fs.readFileSync(ADC, 'utf8'));
}

async function getToken() {
  if (cache.v && cache.exp > Date.now() + 300000) return cache.v;
  const adc = readADC();
  if (adc.type !== 'authorized_user') {
    throw new Error('ADC type is ' + adc.type + ', expected authorized_user');
  }
  const form = new URLSearchParams({
    client_id: adc.client_id,
    client_secret: adc.client_secret,
    refresh_token: adc.refresh_token,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const j = await r.json();
  if (!r.ok) throw new Error('oauth ' + r.status + ' ' + (j.error_description || j.error || 'unknown'));
  cache = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cache.v;
}

function send(res, code, obj) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async function (req, res) {
  const t0 = Date.now();
  let pathname = String(req.url || '/').split('?')[0];
  let model = '-';
  let attempts = 0;
  let upMs = 0;
  let note = '';

  // --- 2026-10-21 观测增强：区分"慢"是上游排队、长输出，还是非流式等全文 ---
  let streamMode = -1;   // 1=流式 0=非流式 -1=请求体未解析
  let nMsgs = 0;         // messages 条数：新窗口首轮通常 1~2
  let nTools = 0;        // tools 数组长度
  let nChars = 0;        // 请求体字符数（粗估输入规模）
  let effort = '-';      // reasoning_effort 档位
  let maxTok = '-';      // 客户端声明的输出上限
  let outBytes = 0;      // 实际回给客户端的字节数（流式含 SSE 包装）

  // 统计出站字节：hook write/end，不干预流控
  const _write = res.write.bind(res);
  const _end = res.end.bind(res);
  function countBytes(chunk) {
    if (!chunk || typeof chunk === 'function') return;
    outBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
  }
  res.write = function (chunk, enc, cb) {
    countBytes(chunk);
    return _write(chunk, enc, cb);
  };
  res.end = function (chunk, enc, cb) {
    countBytes(chunk);
    return _end(chunk, enc, cb);
  };

  // 每个请求一行访问日志，落在 journal 里
  res.on('finish', function () {
    log('ACCESS', {
      m: req.method,
      p: pathname,
      model: model,
      status: res.statusCode,
      ms: Date.now() - t0,
      up_ms: upMs,
      stream: streamMode,
      msgs: nMsgs,
      tools: nTools,
      chars: nChars,
      effort: effort,
      max_tok: maxTok,
      out_b: outBytes,
      try: attempts,
      note: note
    });
  });

  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;

    if (u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    if (AUTH) {
      const got = req.headers.authorization || '';
      if (got !== 'Bearer ' + AUTH) {
        note = 'bad-key';
        return send(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
      }
    }

    if (u.pathname === '/v1/models' || u.pathname === '/models') {
      return send(res, 200, {
        object: 'list',
        data: MODELS.map(function (m) { return { id: m, object: 'model', created: 0, owned_by: 'google' }; })
      });
    }

    if (u.pathname !== '/v1/chat/completions' && u.pathname !== '/chat/completions') {
      note = 'no-route';
      return send(res, 404, { error: { message: 'not found: ' + u.pathname } });
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      note = 'bad-json';
      return send(res, 400, { error: { message: 'invalid json body' } });
    }

    model = String(body.model || 'gemini-2.5-flash');
    if (!model.includes('/')) model = 'google/' + model;
    body.model = model;

    // 观测增强：把这次请求的形态记下来，才能给"慢"归因
    streamMode = body.stream ? 1 : 0;
    nMsgs = Array.isArray(body.messages) ? body.messages.length : 0;
    nTools = Array.isArray(body.tools) ? body.tools.length : 0;
    nChars = raw.length;
    effort = body.reasoning_effort || (body.reasoning && body.reasoning.effort) || '-';
    maxTok = body.max_completion_tokens || body.max_tokens || '-';

    const at = await getToken();
    const host = LOC === 'global' ? 'aiplatform.googleapis.com' : LOC + '-aiplatform.googleapis.com';
    const upstream = UPSTREAM_OVERRIDE || ('https://' + host + '/v1/projects/' + PROJECT +
      '/locations/' + LOC + '/endpoints/openapi/chat/completions');
    const payload = JSON.stringify(body);

    // 客户端断开就中止上游请求，避免白烧 token（重试期间尤其重要）
    const ac = new AbortController();
    let abortReason = '';   // 'client' 客户端断开 / 'ttfb' 上游首字节超时
    res.on('close', function () {
      if (!res.writableEnded) { abortReason = abortReason || 'client'; ac.abort(); }
    });

    let up = null;
    const ttfbMs = streamMode === 1 ? TTFB_STREAM_MS : TTFB_NONSTREAM_MS;
    for (let i = 1; i <= RETRY_MAX + 1; i++) {
      attempts = i;
      const tUp = Date.now();
      let r = null;
      let timedOut = false;
      // 只在上游给响应头之前计时；一旦拿到响应头立即清掉，不干扰后续流式传输
      const ttfbTimer = setTimeout(function () {
        timedOut = true;
        if (!abortReason) abortReason = 'ttfb';
        ac.abort();
      }, ttfbMs);
      try {
        r = await fetch(upstream, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' },
          body: payload,
          signal: ac.signal
        });
        upMs = Date.now() - tUp;
      } catch (e) {
        upMs = Date.now() - tUp;
        if (timedOut) {
          // 上游接到了请求却迟迟不回，重试只会让用户再等一轮，直接明确失败
          note = 'ttfb-timeout:' + Math.round(upMs / 1000) + 's';
          log('TTFB_TIMEOUT', {
            model: model, waited_ms: upMs, limit_ms: ttfbMs, stream: streamMode,
            msgs: nMsgs, tools: nTools, chars: nChars
          });
          send(res, 504, {
            error: {
              message: 'upstream sent no response headers within ' + Math.round(ttfbMs / 1000) +
                's (' + model + '), it is likely overloaded — retry later or switch model',
              type: 'upstream_timeout',
              code: 504
            }
          });
          return;
        }
        if (e && e.name === 'AbortError') {
          note = 'client-abort';
          throw e;
        }
        note = 'upstream-fetch:' + short(e && e.message, 160);
        if (i <= RETRY_MAX) {
          const d = backoffMs(i, 0);
          log('RETRY', { model: model, attempt: i, reason: 'fetch-error', wait_ms: d, err: short(e && e.message, 120) });
          await sleep(d);
          continue;
        }
        throw e;
      } finally {
        // 拿到响应头（或本轮已失败）就停表，避免误伤后续流式传输和下一次重试
        clearTimeout(ttfbTimer);
      }

      if (RETRY_ON.has(r.status) && i <= RETRY_MAX) {
        let txt = '';
        try { txt = await r.text(); } catch (e) { /* ignore */ }
        const ra = Number(r.headers.get('retry-after'));
        const d = backoffMs(i, isFinite(ra) ? ra : 0);
        note = 'up-' + r.status + ':' + short(txt, 160);
        log('RETRY', { model: model, attempt: i, status: r.status, wait_ms: d, retry_after: isFinite(ra) ? ra : '-', body: short(txt, 160) });
        await sleep(d);
        continue;
      }

      up = r;
      break;
    }

    // 非 2xx：读完小响应体记日志，再原样回给客户端
    if (up.status >= 400) {
      let txt = '';
      try { txt = await up.text(); } catch (e) { /* ignore */ }
      note = 'up-' + up.status + ':' + short(txt, 300);
      log('UPSTREAM_FAIL', { model: model, status: up.status, tries: attempts, body: short(txt, 300) });
      const ct = up.headers.get('content-type') || 'application/json';
      if (!res.headersSent) {
        res.writeHead(up.status, { 'content-type': ct });
        return res.end(txt);
      }
      return;
    }

    const ct = up.headers.get('content-type') || 'application/json';
    res.writeHead(up.status, { 'content-type': ct });

    if (up.body) {
      const rs = Readable.fromWeb(up.body);
      rs.on('error', function (e) {
        note = 'stream:' + short(e && e.message, 120);
        log('STREAM_ERR', { model: model, err: note });
        if (!res.writableEnded && !res.destroyed) res.destroy();
      });
      res.on('close', function () {
        if (!res.writableEnded && !rs.destroyed) rs.destroy();
      });
      rs.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    note = short((err && err.message) || err, 200);
    log('ERROR', { model: model, tries: attempts, err: note });
    send(res, 502, { error: { message: String((err && err.message) || err) } });
  }
});

if (!PROJECT) {
  console.error('GCP_PROJECT is required');
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', function () {
  console.log('[BOOT] %s vertex-proxy listening on %s -> project %s @ %s | retry_max=%s base_ms=%s cap_ms=%s',
    new Date().toISOString(), PORT, PROJECT, LOC, RETRY_MAX, RETRY_BASE_MS, RETRY_CAP_MS);
});
