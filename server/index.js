import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfig, saveConfig, resetGuide, adminPassword, defaultPrompts, rid } from './config.js';
import { prepare, handleStream, handleJson, HttpError } from './proxy.js';
import { classify, clearClassifierCache } from './classifier.js';
import { listModels, providerById } from './upstream.js';
import { stats } from './stats.js';

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

loadConfig();
const ADMIN_PASSWORD = adminPassword();

// ---------- helpers ----------

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}

function apiError(res, status, message, type = 'invalid_request_error') {
  if (res.headersSent) return res.end();
  sendJson(res, status, { error: { message, type } });
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- sessions (stateless signed cookie) ----------

function sign(payload) {
  return crypto.createHmac('sha256', getConfig().sessionSecret).update(payload).digest('base64url');
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function isAdmin(req) {
  const m = /(?:^|;\s*)imp_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers['x-api-key'] || '';
}

function apiKeyOk(req) {
  const cfg = getConfig();
  if (!cfg.requireApiKey) return true;
  const k = bearer(req);
  return !!k && cfg.apiKeys.some(x => safeEq(x.key, k));
}

// Simple per-IP throttle for login attempts.
const attempts = new Map();
function loginAllowed(ip) {
  const a = attempts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - a.at > 10 * 60e3) Object.assign(a, { n: 0, at: Date.now() });
  attempts.set(ip, a);
  return a.n < 10;
}

// ---------- public views of config ----------

const mask = k => (k ? k.slice(0, 4) + '…' + k.slice(-4) : '');

function publicState() {
  const c = getConfig();
  return {
    requireApiKey: c.requireApiKey,
    apiKeys: c.apiKeys,
    providers: c.providers.map(p => ({ ...p, apiKey: '', apiKeyPreview: mask(p.apiKey), apiKeySet: !!p.apiKey })),
    classifier: c.classifier,
    advisor: c.advisor,
    models: c.models,
    guides: c.guides,
    defaults: defaultPrompts,
    stats: stats.snapshot()
  };
}

// ---------- /v1 (OpenAI-compatible) ----------

async function chatCompletions(req, res) {
  if (!apiKeyOk(req) && !isAdmin(req)) return apiError(res, 401, 'Invalid API key', 'authentication_error');
  const cfg = getConfig();
  const started = Date.now();
  const body = await readBody(req);
  const entry = { model: body.model, stream: !!body.stream, preview: '' };
  stats.bump('requests');
  stats.record(entry);

  const ctrl = new AbortController();
  res.on('close', () => !res.writableFinished && ctrl.abort());

  try {
    const prep = await prepare(cfg, body);
    const cls = prep.meta.classification;
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
    Object.assign(entry, {
      upstreamModel: prep.model.upstreamModel,
      preview: (typeof lastUser?.content === 'string' ? lastUser.content : '[multipart]').slice(0, 140),
      source: cls.source,
      complexity: cls.complexity,
      guides: prep.meta.guides,
      critique: cls.critique,
      classifierMs: cls.ms,
      classifierError: cls.error,
      injectedTokens: prep.meta.injectedTokens,
      tool: prep.toolEnabled
    });
    if (prep.meta.injected) {
      stats.bump('enhanced');
      stats.bump('injectedTokensEst', prep.meta.injectedTokens);
      stats.guideHit(prep.meta.guides);
    } else stats.bump('skipped');

    const debug = isAdmin(req) && req.headers['x-improver-debug'];
    const extra = debug ? { 'x-improver-meta': Buffer.from(JSON.stringify(prep.meta)).toString('base64url') } : {};
    const firstByteAt = Date.now();
    entry.prepMs = firstByteAt - started;

    if (body.stream) {
      stats.bump('streamed');
      const r = await handleStream(cfg, prep, res, ctrl.signal, extra);
      entry.advice = r.advice;
      res.end();
    } else {
      const r = await handleJson(cfg, prep, ctrl.signal);
      entry.advice = r.advice;
      sendJson(res, 200, r.json, extra);
    }
    entry.status = 200;
  } catch (e) {
    if (ctrl.signal.aborted) {
      entry.status = 499;
      return res.end();
    }
    stats.bump('errors');
    entry.status = e.status || 502;
    entry.error = String(e.message).slice(0, 300);
    if (e.raw && !res.headersSent) {
      res.writeHead(e.status, { 'content-type': 'application/json' });
      return res.end(e.raw);
    }
    apiError(res, e.status || 502, e.message, e.type || 'upstream_error');
  } finally {
    entry.totalMs = Date.now() - started;
  }
}

function listV1Models(req, res) {
  if (!apiKeyOk(req) && !isAdmin(req)) return apiError(res, 401, 'Invalid API key', 'authentication_error');
  const data = getConfig()
    .models.filter(m => m.enabled)
    .map(m => ({ id: m.name, object: 'model', created: 0, owned_by: 'ai-improver' }));
  sendJson(res, 200, { object: 'list', data });
}

// ---------- admin API ----------

const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

const MODEL_FIELDS = ['name', 'enabled', 'providerId', 'upstreamModel', 'systemPrompt', 'extraBody', 'enhance'];
const PROVIDER_FIELDS = ['name', 'baseUrl', 'apiKey'];
const GUIDE_FIELDS = ['title', 'hint', 'keywords', 'stickyTriggers', 'text', 'enabled', 'edited', 'category'];
const CLASSIFIER_FIELDS = ['enabled', 'providerId', 'model', 'temperature', 'maxTokens', 'timeoutMs', 'maxInputChars', 'cacheTtlSec', 'skipTrivial', 'extraBody', 'systemPrompt'];
const ADVISOR_FIELDS = ['providerId', 'model', 'maxTokens', 'timeoutMs', 'systemPrompt'];

function crud(list, id, patch, fields, res, makeNew) {
  if (id) {
    const item = list.find(x => x.id === id);
    if (!item) return apiError(res, 404, 'Not found');
    Object.assign(item, pick(patch, fields));
    return item;
  }
  const item = makeNew(pick(patch, fields));
  list.push(item);
  return item;
}

async function admin(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (p === '/login' && method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (!loginAllowed(ip)) return apiError(res, 429, 'Too many attempts, try later');
    const { password } = await readBody(req);
    if (!safeEq(password || '', ADMIN_PASSWORD)) {
      attempts.get(ip).n++;
      return apiError(res, 401, 'Wrong password');
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return sendJson(res, 200, { ok: true }, { 'set-cookie': `imp_session=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
  }
  if (p === '/logout') return sendJson(res, 200, { ok: true }, { 'set-cookie': 'imp_session=; Path=/; Max-Age=0' });
  if (p === '/me') return sendJson(res, 200, { admin: isAdmin(req) });

  if (!isAdmin(req)) return apiError(res, 401, 'Login required', 'authentication_error');
  // CSRF: state-changing admin calls must be same-origin JSON.
  if (method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) return apiError(res, 415, 'JSON required');

  const cfg = getConfig();
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
  const seg = p.split('/').filter(Boolean);
  const [kind, id, action] = seg;
  let out;

  switch (kind) {
    case 'state':
      return sendJson(res, 200, publicState());
    case 'logs':
      return sendJson(res, 200, { logs: stats.logs(200) });
    case 'stats':
      if (method === 'DELETE') stats.reset();
      return sendJson(res, 200, stats.snapshot());
    case 'general':
      if ('requireApiKey' in body) cfg.requireApiKey = !!body.requireApiKey;
      out = { requireApiKey: cfg.requireApiKey };
      break;
    case 'classifier':
      Object.assign(cfg.classifier, pick(body, CLASSIFIER_FIELDS));
      clearClassifierCache();
      out = cfg.classifier;
      break;
    case 'advisor':
      Object.assign(cfg.advisor, pick(body, ADVISOR_FIELDS));
      out = cfg.advisor;
      break;
    case 'classify': {
      const messages = body.messages || [{ role: 'user', content: String(body.text || '') }];
      const model = cfg.models.find(m => m.id === body.modelId) || cfg.models[0];
      const r = await classify(cfg, messages, stats);
      let injected = '';
      if (model) {
        const prep = await prepare(cfg, { model: model.name, messages }).catch(() => null);
        injected = prep?.meta.injected || '';
      }
      return sendJson(res, 200, { ...r, injected });
    }
    case 'providers':
      if (action === 'models') {
        const prov = providerById(cfg, id);
        if (!prov) return apiError(res, 404, 'Not found');
        try {
          return sendJson(res, 200, { models: await listModels(prov) });
        } catch (e) {
          return apiError(res, 502, `Could not list models: ${e.message}`);
        }
      }
      if (method === 'DELETE') {
        if (cfg.models.some(m => m.providerId === id) || cfg.classifier.providerId === id) return apiError(res, 409, 'Provider is in use');
        cfg.providers = cfg.providers.filter(x => x.id !== id);
        out = { ok: true };
        break;
      }
      if (id && !body.apiKey) delete body.apiKey; // empty = keep stored key
      out = crud(cfg.providers, id, body, PROVIDER_FIELDS, res, f => ({ id: rid(), name: 'Provider', baseUrl: '', apiKey: '', ...f }));
      if (res.headersSent) return;
      out = { ...out, apiKey: '', apiKeyPreview: mask(out.apiKey), apiKeySet: !!out.apiKey };
      break;
    case 'models':
      if (method === 'DELETE') {
        cfg.models = cfg.models.filter(x => x.id !== id);
        out = { ok: true };
        break;
      }
      if (body.name && cfg.models.some(m => m.name === body.name && m.id !== id)) return apiError(res, 409, 'Model name already used');
      out = crud(cfg.models, id, body, MODEL_FIELDS, res, f => ({
        id: rid(),
        name: 'new-model',
        enabled: true,
        providerId: cfg.providers[0]?.id || '',
        upstreamModel: '',
        systemPrompt: '',
        extraBody: {},
        enhance: { mode: 'pre', guides: true, critique: true, maxGuides: 2 },
        ...f
      }));
      break;
    case 'guides':
      if (action === 'reset') {
        out = resetGuide(id);
        if (!out) return apiError(res, 404, 'Not a built-in guide');
        clearClassifierCache();
        return sendJson(res, 200, out);
      }
      if (method === 'DELETE') {
        cfg.guides = cfg.guides.filter(x => x.id !== id);
        out = { ok: true };
        break;
      }
      if (!id && body.id && cfg.guides.some(g => g.id === body.id)) return apiError(res, 409, 'Guide id already used');
      if (id && ['title', 'hint', 'keywords', 'text'].some(k => k in body)) body.edited = true;
      out = crud(cfg.guides, id, body, GUIDE_FIELDS, res, f => ({
        id: (body.id || 'custom-' + rid(3)).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        title: 'New guide',
        hint: '',
        keywords: [],
        text: '',
        enabled: true,
        builtin: false,
        category: 'custom',
        ...f
      }));
      clearClassifierCache();
      break;
    case 'keys':
      if (method === 'DELETE') cfg.apiKeys = cfg.apiKeys.filter(k => k.id !== id);
      else cfg.apiKeys.push({ id: rid(), name: body.name || 'key', key: 'sk-imp-' + rid(20), created: Date.now() });
      out = cfg.apiKeys;
      break;
    default:
      return apiError(res, 404, 'Unknown endpoint');
  }
  if (res.headersSent) return;
  saveConfig();
  sendJson(res, 200, out);
}

// ---------- static ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic(res, '/');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key',
        'access-control-allow-methods': 'GET, POST, OPTIONS'
      });
      return res.end();
    }
    if (p.startsWith('/v1')) res.setHeader('access-control-allow-origin', '*');
    if (p === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);
    if (p === '/v1/models' && req.method === 'GET') return listV1Models(req, res);
    if (p === '/health') return sendJson(res, 200, { ok: true });
    if (p.startsWith('/v1/')) return apiError(res, 404, 'Not supported by AI Improver');
    if (p.startsWith('/api/')) return await admin(req, res, url);
    if (req.method === 'GET') return serveStatic(res, p);
    apiError(res, 404, 'Not found');
  } catch (e) {
    apiError(res, e.status || 500, e.message || 'Internal error', e.type);
  }
});

server.requestTimeout = 0; // long streams
server.headersTimeout = 60e3;
server.listen(PORT, HOST, () => console.log(`[improver] listening on http://${HOST}:${PORT}`));

export default server;
