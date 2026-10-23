'use strict';
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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
// 重试总预算：从请求开始算，超过这个时长就不再重试，直接把 429/503 还给客户端。
// 依据：上游 429 往往要 40 秒才吐出来，4 次重试能把失败拖到 110 秒，用户以为卡死。
const RETRY_BUDGET_MS = Number(process.env.RETRY_BUDGET_MS || 25000);
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

// --- thought_signature 代管（2026-10-23 新增）---
// Gemini 3 起，functionCall part 必须携带 thoughtSignature，否则上游直接 400：
//   Function call is missing a thought_signature in functionCall parts.
// 上游确实会返回它，位置在 choices[].message.tool_calls[].extra_content.google.thought_signature。
// 但客户端（Operit 等）解析 OpenAI 兼容响应时只保留 id/type/function，extra_content 被丢弃，
// 下一轮回传历史就变成"无签名 functionCall"，于是第一轮能调工具、第二轮必挂。
// 代理这里按 tool_call id 把签名存档，请求转发前补回；缓存未命中时用官方占位值兜底，
// 保证不会因为代理重启或换设备而再次 400。
const SIG_ON = process.env.THOUGHT_SIG !== '0';
const SIG_MODE = String(process.env.THOUGHT_SIG_MODE || 'cache').toLowerCase(); // cache | skip
const SIG_SKIP = 'skip_thought_signature_validator';   // Google 文档给出的校验跳过值
const SIG_TTL_MS = Number(process.env.THOUGHT_SIG_TTL_MS || 6 * 3600 * 1000);
const SIG_SSE_MAX = Number(process.env.THOUGHT_SIG_SSE_MAX || 8 * 1024 * 1024); // 旁听缓冲上限
const SIG_MAX = Number(process.env.THOUGHT_SIG_MAX || 4000);   // 每条签名占 2 个索引，实际约存一半
const sigStore = new Map();   // key -> { sig, t }；key 为 "id:<tool_call id>" 或 "k:<内容指纹>"

// 内容指纹：部分客户端（实测 Operit）每轮都会重新生成 tool_call id，
// 只用 id 做 key 会让缓存永远打不中、全部退化成占位值。
// 所以额外按 function name + arguments 存一份指纹索引，id 变了也能命中。
function canon(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const ks = Object.keys(v).sort();
  return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
}

function argCanon(args) {
  if (args == null) return '{}';
  if (typeof args === 'object') return canon(args);
  const s = String(args).trim();
  try { return canon(JSON.parse(s)); } catch (e) { return s; }   // 不是合法 JSON 就按原文比对
}

function sigKey(name, args) {
  return 'k:' + crypto.createHash('sha1')
    .update(String(name || '') + '\u0000' + argCanon(args))
    .digest('hex').slice(0, 16);
}

function rememberSig(key, sig) {
  if (!key || !sig) return;
  if (sigStore.size >= SIG_MAX) {
    const oldest = sigStore.keys().next();
    if (!oldest.done) sigStore.delete(oldest.value);
  }
  sigStore.delete(key);          // 重新插入，维持近似 LRU 顺序
  sigStore.set(key, { sig: sig, t: Date.now() });
}

function lookupSig(key) {
  const k = String(key || '');
  if (!k) return '';
  const e = sigStore.get(k);
  if (!e) return '';
  if (Date.now() - e.t > SIG_TTL_MS) { sigStore.delete(k); return ''; }
  return e.sig;
}

// 从非流式响应体里抓签名。返回抓到几条。
function harvestSigs(text) {
  let j = null;
  try { j = JSON.parse(text); } catch (e) { return 0; }
  const chs = j && Array.isArray(j.choices) ? j.choices : [];
  let n = 0;
  for (let i = 0; i < chs.length; i++) {
    const msg = chs[i] && chs[i].message;
    const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (let k = 0; k < tcs.length; k++) {
      const c = tcs[k] || {};
      const g = c.extra_content && c.extra_content.google;
      if (g && g.thought_signature) {
        const fn = c.function || {};
        rememberSig('id:' + c.id, g.thought_signature);              // 主索引
        rememberSig(sigKey(fn.name, fn.arguments), g.thought_signature); // 指纹索引
        n++;
      }
    }
  }
  return n;
}

// 从流式 SSE 里抓签名。delta.tool_calls 按 index 分片下发，先合并再取。
// 只读旁听：不改变发给客户端的任何字节。
function harvestSse(text) {
  const lines = String(text || '').split('\n');
  const acc = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.indexOf('data:') !== 0) continue;
    const payload = ln.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j = null;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    const chs = j && Array.isArray(j.choices) ? j.choices : [];
    for (let c = 0; c < chs.length; c++) {
      const d = chs[c] && (chs[c].delta || chs[c].message);
      const tcs = d && Array.isArray(d.tool_calls) ? d.tool_calls : [];
      for (let k = 0; k < tcs.length; k++) {
        const t = tcs[k] || {};
        const idx = typeof t.index === 'number' ? t.index : k;
        const cur = acc[idx] || (acc[idx] = { id: '', name: '', args: '', sig: '' });
        if (t.id) cur.id = t.id;
        const fn = t.function || {};
        if (fn.name && !cur.name) cur.name = fn.name;
        if (typeof fn.arguments === 'string') cur.args += fn.arguments;
        const g = t.extra_content && t.extra_content.google;
        if (g && g.thought_signature) cur.sig = g.thought_signature;
      }
    }
  }
  let n = 0;
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i];
    if (!a || !a.sig) continue;
    rememberSig('id:' + a.id, a.sig);
    rememberSig(sigKey(a.name, a.args), a.sig);
    n++;
  }
  return n;
}

// 请求侧补签名：就地改 body.messages 里 assistant.tool_calls 缺的 extra_content。
function injectSigs(body, stat) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.tool_calls)) continue;
    for (let k = 0; k < m.tool_calls.length; k++) {
      const c = m.tool_calls[k];
      if (!c || typeof c !== 'object') continue;
      const g0 = c.extra_content && c.extra_content.google;
      if (g0 && g0.thought_signature) { stat.have++; continue; }
      const fn = c.function || {};
      let hit = '';
      let byKey = 0;
      if (SIG_MODE !== 'skip') {
        hit = lookupSig('id:' + c.id);
        if (!hit) {
          hit = lookupSig(sigKey(fn.name, fn.arguments));
          if (hit) byKey = 1;
        }
      }
      const val = hit || SIG_SKIP;
      const ec = Object.assign({}, c.extra_content || {});
      ec.google = Object.assign({}, (c.extra_content && c.extra_content.google) || {},
        { thought_signature: val });
      c.extra_content = ec;
      stat.fill++;
      if (hit) { stat.hit++; if (byKey) stat.khit++; } else { stat.skip++; }
    }
  }
}

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
  let sigStat = null;    // thought_signature 代管：{have, fill, hit, skip, got}

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
      sig: sigStat && (sigStat.fill || sigStat.got)
        ? ('f' + sigStat.fill + 'h' + sigStat.hit + 'k' + sigStat.khit +
           's' + sigStat.skip + 'g' + sigStat.got)
        : '-',
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

    // thought_signature 代管：客户端回传历史时会丢掉 tool_calls[].extra_content，
    // 上游要求 functionCall 必带签名，所以转发前就地补回（缓存命中优先，否则用占位值）
    if (SIG_ON) {
      sigStat = { have: 0, fill: 0, hit: 0, khit: 0, skip: 0, got: 0 };
      try { injectSigs(body, sigStat); } catch (e) {
        note = 'sig-err:' + short(e && e.message, 60);
      }
    }

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
    let upText = null;   // 预算耗尽提前退出时，响应体已读走，留给下面复用
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
        const dErr = backoffMs(i, 0);
        if (i <= RETRY_MAX && (Date.now() - t0 + dErr) <= RETRY_BUDGET_MS) {
          log('RETRY', { model: model, attempt: i, reason: 'fetch-error', wait_ms: dErr, err: short(e && e.message, 120) });
          await sleep(dErr);
          continue;
        }
        if (i <= RETRY_MAX) {
          note = 'retry-budget-exhausted:fetch-error:' + (Date.now() - t0) + 'ms';
          log('RETRY_SKIP', { model: model, attempt: i, reason: 'budget', elapsed_ms: Date.now() - t0 });
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
        const elapsed = Date.now() - t0;
        // 预算不够就不再重试：上游 429 常常要等几十秒才吐，硬重试会把失败拖成两分钟
        if (elapsed + d > RETRY_BUDGET_MS) {
          up = r;
          upText = txt;
          attempts = i;
          note = 'up-' + r.status + ':budget-exhausted:' + elapsed + 'ms';
          log('RETRY_SKIP', {
            model: model, attempt: i, status: r.status,
            elapsed_ms: elapsed, budget_ms: RETRY_BUDGET_MS, body: short(txt, 120)
          });
          break;
        }
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
      let txt = upText != null ? upText : '';
      if (upText == null) {
        try { txt = await up.text(); } catch (e) { /* ignore */ }
      }
      if (note.indexOf('budget-exhausted') < 0) note = 'up-' + up.status + ':' + short(txt, 300);
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

    // 图像模型 + 流式：客户端要的是 SSE，但上游把图片 base64 分块塞进 delta.audio.data，
    // 客户端不认识这个字段，只会显示成乱码或空白。
    // 这里读完整个上游流，取出图片落盘，再用一条干净的 SSE 把 markdown 链接发回去。
    if (IMG_SAVE && streamMode === 1 && /image/i.test(model) && up.body) {
      let sb = null;
      try { sb = Buffer.from(await up.arrayBuffer()); } catch (e) { sb = null; }
      if (sb) {
        const text = sb.toString('utf8');
        let content = '';
        let b64 = '';
        let finish = 'stop';
        let id = '';
        let created = Math.floor(Date.now() / 1000);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (ln.indexOf('data:') !== 0) continue;
          const js = ln.slice(5).trim();
          if (!js || js === '[DONE]') continue;
          let o = null;
          try { o = JSON.parse(js); } catch (e) { continue; }
          if (o.id) id = o.id;
          if (o.created) created = o.created;
          const ch = o.choices && o.choices[0];
          if (!ch) continue;
          if (ch.finish_reason) finish = ch.finish_reason;
          const d = ch.delta || {};
          if (typeof d.content === 'string') content += d.content;
          if (d.audio && typeof d.audio.data === 'string') b64 += d.audio.data;
        }
        const ext = b64 ? sniffImageExt(b64) : '';
        if (ext) {
          const rel = saveImage(b64, ext);
          const base = PUBLIC_BASE || ('http://' + (req.headers.host || ('127.0.0.1:' + PORT)));
          const url = rel ? base + rel : '';
          const txt = content.trim();
          content = (txt ? txt + '\n\n' : '') +
            (url ? '![' + ext + '](' + url + ')' : '(图片已生成但落盘失败)');
          imgB = Buffer.from(b64, 'base64').length;
          imgUrl = url;
        }
        const mk = function (delta, fr) {
          return 'data: ' + JSON.stringify({
            id: id || ('chatcmpl-' + Date.now()),
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [{ index: 0, delta: delta, finish_reason: fr === undefined ? null : fr }]
          }) + '\n\n';
        };
        const out = Buffer.from(
          mk({ role: 'assistant', content: '' }) +
          mk({ content: content }) +
          mk({}, finish) +
          'data: [DONE]\n\n', 'utf8');
        res.writeHead(up.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'content-length': out.length
        });
        return res.end(out);
      }
    }

    // thought_signature 代管（非流式）：上游把签名放在 tool_calls[].extra_content 里，
    // 客户端解析后丢弃，下一轮就 400。这里读完整个响应体，先存档再原样回给客户端。
    // 非流式本来就等全文生成完，读全量不增加延迟。
    // 流式路径在下面旁听提取（见 harvestSse），不阻断转发。
    if (SIG_ON && streamMode === 0 && up.body && !res.headersSent) {
      let ab = null;
      try { ab = Buffer.from(await up.arrayBuffer()); } catch (e) { ab = null; }
      if (!ab) {
        note = note || 'sig-read-fail';
        return send(res, 502, { error: { message: 'upstream body read failed', type: 'proxy_error' } });
      }
      const got = harvestSigs(ab.toString('utf8'));
      if (sigStat) sigStat.got = got;
      res.writeHead(up.status, { 'content-type': ct, 'content-length': ab.length });
      return res.end(ab);
    }

    res.writeHead(up.status, { 'content-type': ct });

    if (up.body) {
      const rs = Readable.fromWeb(up.body);
      // 流式同样要抓签名：上游把签名放在 delta.tool_calls[].extra_content 里。
      // 这里只旁听（额外挂一个 data 监听），不改写、不缓冲后再发，客户端收到的字节与上游完全一致。
      const bags = SIG_ON ? [] : null;
      let bagBytes = 0;
      if (bags) {
        rs.on('data', function (ch) {
          if (bagBytes > SIG_SSE_MAX) return;
          bagBytes += ch.length;
          bags.push(ch);
        });
        rs.on('end', function () {
          if (!bagBytes) return;
          if (bagBytes > SIG_SSE_MAX) { note = note || 'sig-sse-too-big'; return; }
          const got = harvestSse(Buffer.concat(bags).toString('utf8'));
          if (got && sigStat) sigStat.got += got;
        });
      }
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
  console.log('[BOOT] %s vertex-proxy listening on %s -> project %s @ %s | retry_max=%s base_ms=%s cap_ms=%s budget_ms=%s ttfb_stream=%s ttfb_nonstream=%s',
    new Date().toISOString(), PORT, PROJECT, LOC, RETRY_MAX, RETRY_BASE_MS, RETRY_CAP_MS,
    RETRY_BUDGET_MS, TTFB_STREAM_MS, TTFB_NONSTREAM_MS);
});
