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

// --- 图像模型响应适配（2026-10-21 新增）---
// Vertex 的 OpenAI 兼容层出图时，base64 塞在 message.audio.data，content 为空，
// 还附一条假的 refusal:"Unexpected tool call ... google:image_gen"。
// 一张图 base64 约 2.4MB，直接留在 content 里会进对话历史，下一轮请求直接撑爆上下文。
// 所以落盘成文件，content 只留一行 markdown 链接。
const IMG_SAVE = process.env.IMAGE_SAVE !== '0';        // 设为 0 则关闭适配，原样透传
const IMG_DIR = process.env.IMAGE_DIR || '/root/vertex-proxy/images';
const IMG_KEEP = Number(process.env.IMAGE_KEEP || 200); // 目录里最多保留多少张
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// 客户端（Operit 等）不会自己带 modalities。实测表明：请求体不写 modalities 时，
// 图像模型只回文本、根本不出图，等于选了也没用。所以由代理补上，可用环境变量关掉。
const IMAGE_AUTO_MODALITY = process.env.IMAGE_AUTO_MODALITY !== '0';

const MODELS = [
  'google/gemini-4-argon',
  'google/gemini-3.8-flash',
  'google/gemini-3.7-flash',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-3-pro-image',
  'google/gemini-3.1-flash-image',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3.1-flash-lite-image'
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

// 从 base64 头部判断图片格式，不引入任何依赖
function sniffImageExt(b64) {
  if (b64.startsWith('iVBORw0KGgo')) return 'png';
  if (b64.startsWith('/9j/')) return 'jpg';
  if (b64.startsWith('R0lGOD')) return 'gif';
  if (b64.startsWith('UklGR')) return 'webp';
  return '';
}

function trimImageDir() {
  try {
    const names = fs.readdirSync(IMG_DIR).filter(function (n) { return /^img-/.test(n); });
    if (names.length <= IMG_KEEP) return;
    names.sort();                        // 文件名前缀带毫秒时间戳，字典序等于时间序
    const drop = names.slice(0, names.length - IMG_KEEP);
    for (let i = 0; i < drop.length; i++) {
      try { fs.unlinkSync(IMG_DIR + '/' + drop[i]); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// 把图片写进 IMG_DIR，返回可访问的相对路径；失败返回空串
function saveImage(b64, ext) {
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const name = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(IMG_DIR + '/' + name, Buffer.from(b64, 'base64'));
    trimImageDir();
    return '/images/' + name;
  } catch (e) {
    return '';
  }
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
  let imgB = 0;          // 图像响应：落盘图片的原始字节数（0 表示这次没出图）
  let imgUrl = '';       // 图像响应：改写进 content 的访问地址

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
      img_b: imgB || '-',
      img_url: imgUrl || '-',
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

    // 图片静态路由：必须放在鉴权之前。
    // 客户端的 <img>/markdown 渲染不会带 Authorization 头，加鉴权等于图永远 401。
    // 文件名是 13 位时间戳 + 6 位随机串，不可枚举、不可猜。
    if (u.pathname.indexOf('/images/') === 0) {
      const name = u.pathname.slice('/images/'.length);
      if (!/^img-[A-Za-z0-9._-]+$/.test(name)) {
        return send(res, 400, { error: { message: 'bad image name' } });
      }
      return fs.readFile(IMG_DIR + '/' + name, function (e, buf) {
        if (e) return send(res, 404, { error: { message: 'image not found' } });
        const ext = (name.split('.').pop() || '').toLowerCase();
        const mime = ext === 'png' ? 'image/png'
          : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : 'application/octet-stream';
        res.writeHead(200, {
          'content-type': mime,
          'content-length': buf.length,
          'cache-control': 'public, max-age=86400'
        });
        res.end(buf);
      });
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

    if (IMAGE_AUTO_MODALITY && /image/i.test(model) && !body.modalities) {
      body.modalities = ['text', 'image'];
    }

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

    // 图像模型：只在非流式下改写。要落盘就必须读完整个响应体，流式改写会破坏 SSE。
    if (IMG_SAVE && streamMode === 0 && /image/i.test(model) && up.body) {
      let ab = null;
      try { ab = Buffer.from(await up.arrayBuffer()); } catch (e) { ab = null; }
      if (ab) {
        let j = null;
        try { j = JSON.parse(ab.toString('utf8')); } catch (e) { j = null; }
        const m0 = j && j.choices && j.choices[0] && j.choices[0].message;
        const b64 = m0 && m0.audio && typeof m0.audio.data === 'string' ? m0.audio.data : '';
        const ext = b64 ? sniffImageExt(b64) : '';
        if (m0 && ext) {
          const rel = saveImage(b64, ext);
          const base = PUBLIC_BASE || ('http://' + (req.headers.host || ('127.0.0.1:' + PORT)));
          const url = rel ? base + rel : '';
          const txt = typeof m0.content === 'string' ? m0.content.trim() : '';
          m0.content = (txt ? txt + '\n\n' : '') +
            (url ? '![' + ext + '](' + url + ')' : '(图片已生成但落盘失败)');
          delete m0.audio;
          // 这条 refusal 是兼容层把内部的 google:image_gen 工具调用当成"未声明函数"报的假警，
          // 原样留着会让客户端判定为失败，而图片其实已经生成好了
          delete m0.refusal;
          imgB = Buffer.from(b64, 'base64').length;
          imgUrl = url;
          const out = Buffer.from(JSON.stringify(j), 'utf8');
          res.writeHead(up.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': out.length });
          return res.end(out);
        }
        // 只是文本回答（图像模型也能纯聊天）：原样回放
        res.writeHead(up.status, { 'content-type': ct, 'content-length': ab.length });
        return res.end(ab);
      }
    }

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
