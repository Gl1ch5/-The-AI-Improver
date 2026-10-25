// Learning mode. Agent conversations are tracked by their first user message;
// once one goes quiet for `idleMin`, a small model reads a compact digest of
// it (user turns, errors, tool calls — not the full transcript) and writes
// reusable notes into the library as `learned` guides. Notes may carry error
// `patterns` that attach them instantly, without the classifier.
import crypto from 'node:crypto';
import { textOf, parseJsonLoose, clearClassifierCache } from './classifier.js';
import { providerById, quickCompletion } from './upstream.js';
import { saveConfig } from './config.js';
import { stats } from './stats.js';

const MAX_SESSIONS = 40;
const sessions = new Map(); // key -> { key, model, title, firstAt, lastAt, requests, messages }
const analyzed = new Map(); // key -> message count already learned from
const events = [];

const ERROR_LINE = /\b(error|exception|traceback|failed|failure|fatal|panic|cannot|can't|invalid|not found|undefined|segfault)\b|ошибк|не удалось/i;
const firstUserText = messages => textOf(messages.find(m => m.role === 'user')?.content);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const userTurns = msgs => msgs.filter(m => m.role === 'user' && !isToolDump(textOf(m.content))).length;
// Some agents (Cline, Roo) send tool output as user messages.
const isToolDump = t => t.length > 1500 || /^\s*\[[\w ]+(?: for [^\]]*)?\] Result:/.test(t);

function errorLines(text, max = 400) {
  const out = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (!ERROR_LINE.test(line)) continue;
    const l = clip(line.trim(), 200);
    if (size + l.length > max) break;
    out.push(l);
    size += l.length;
  }
  return out.join(' | ');
}

export function sessionKey(model, messages) {
  const first = firstUserText(messages);
  if (!first) return null;
  return crypto.createHash('sha1').update(model + '\0' + first.slice(0, 2000)).digest('hex').slice(0, 16);
}

// Called for every proxied request. Keeps a reference to the longest message
// list seen per conversation; nothing is sent anywhere until the session ends.
export function track(cfg, model, messages) {
  if (!cfg.learning?.enabled || !Array.isArray(messages)) return;
  const key = sessionKey(model, messages);
  if (!key) return;
  let s = sessions.get(key);
  if (!s) {
    s = { key, model, title: clip(firstUserText(messages).replace(/\s+/g, ' '), 90), firstAt: Date.now(), requests: 0, messages: [] };
    sessions.set(key, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
      sessions.delete(oldest.key);
      queue(cfg, oldest);
    }
  }
  s.lastAt = Date.now();
  s.requests++;
  if (messages.length >= s.messages.length) s.messages = messages;
}

// Compact transcript: the task, every real user turn, short assistant text,
// tool names, and only the error lines of tool output. Over budget, the
// oldest assistant lines go first, then the oldest of everything else.
export function digest(messages, from, maxChars) {
  const first = firstUserText(messages);
  const lines = [{ p: 9, s: `TASK: ${clip(first, 700)}` }];
  let skippedFirst = false;
  for (const m of messages.slice(from)) {
    const t = textOf(m.content);
    if (m.role === 'user') {
      if (!skippedFirst && t === first) {
        skippedFirst = true;
        continue;
      }
      if (isToolDump(t)) {
        const err = errorLines(t);
        if (err) lines.push({ p: 2, s: `TOOL ERROR: ${err}` });
      } else lines.push({ p: 3, s: `USER: ${clip(t, 600)}` });
    } else if (m.role === 'assistant') {
      if (t.trim()) lines.push({ p: 0, s: `AI: ${clip(t.trim().replace(/\s+/g, ' '), 220)}` });
      for (const c of m.tool_calls || []) lines.push({ p: 1, s: `AI calls ${c.function?.name}(${clip(String(c.function?.arguments || ''), 100)})` });
    } else if (m.role === 'tool') {
      const err = errorLines(t);
      if (err) lines.push({ p: 2, s: `TOOL ERROR: ${err}` });
    }
  }
  let total = lines.reduce((n, l) => n + l.s.length + 1, 0);
  for (const p of [0, 1, 2, 3]) {
    for (const l of lines) {
      if (total <= maxChars) break;
      if (l.p === p && !l.drop) {
        l.drop = true;
        total -= l.s.length + 1;
      }
    }
  }
  return lines.filter(l => !l.drop).map(l => l.s).join('\n');
}

// Learned notes that look related, so the model updates them instead of
// writing near-duplicates. Local keyword overlap, no tokens.
function related(cfg, text, limit = 3) {
  const t = text.toLowerCase();
  return cfg.guides
    .filter(g => g.learned)
    .map(g => ({ g, s: (g.keywords || []).filter(k => t.includes(k.toLowerCase())).length + (g.topic && t.includes(g.topic) ? 2 : 0) }))
    .filter(x => x.s > 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.g);
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const strList = (x, n, len) => (Array.isArray(x) ? x.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, len)).slice(0, n) : []);

export function applyNotes(cfg, notes, sessionText) {
  const L = cfg.learning;
  const lower = sessionText.toLowerCase();
  const saved = [];
  for (const n of (Array.isArray(notes) ? notes : []).slice(0, 3)) {
    const text = typeof n.text === 'string' ? n.text.trim().slice(0, 1200) : '';
    let id = slug(n.id || n.title);
    if (!id || text.length < 80) continue;
    const fields = {
      title: String(n.title || id).slice(0, 80),
      hint: String(n.hint || '').slice(0, 80),
      topic: slug(n.topic).split('-')[0] || 'general',
      keywords: strList(n.keywords, 10, 40),
      // Only error strings that really occurred, so a hallucinated pattern cannot fire on everything.
      patterns: strList(n.patterns, 4, 120).filter(p => p.length >= 8 && lower.includes(p.toLowerCase())),
      text
    };
    const existing = cfg.guides.find(g => g.id === id);
    if (existing?.learned && !existing.edited) {
      Object.assign(existing, fields, { patterns: [...new Set([...(existing.patterns || []), ...fields.patterns])].slice(0, 6) });
      existing.learned = { ...existing.learned, at: Date.now(), sessions: (existing.learned.sessions || 1) + 1 };
      saved.push(id);
      continue;
    }
    if (existing) id = id + '-learned';
    if (cfg.guides.some(g => g.id === id)) continue;
    cfg.guides.push({ id, ...fields, category: 'learned', builtin: false, enabled: !!L.autoEnable, learned: { at: Date.now(), sessions: 1 } });
    saved.push(id);
  }
  // Oldest untouched learned notes make room for new ones.
  const learned = cfg.guides.filter(g => g.learned && !g.edited).sort((a, b) => a.learned.at - b.learned.at);
  const extra = cfg.guides.filter(g => g.learned).length - L.maxLearned;
  if (extra > 0) {
    const drop = new Set(learned.slice(0, extra).map(g => g.id));
    cfg.guides = cfg.guides.filter(g => !drop.has(g.id));
  }
  if (saved.length) {
    saveConfig();
    clearClassifierCache();
  }
  return saved;
}

async function analyze(cfg, s) {
  const L = cfg.learning;
  const from = analyzed.get(s.key) || 0;
  const fresh = s.messages.slice(from);
  const ev = { at: Date.now(), key: s.key, title: s.title, model: s.model, messages: s.messages.length, notes: [] };
  if (userTurns(fresh) < L.minUserTurns && fresh.length < L.minMessages) {
    ev.skipped = 'short';
    return record(ev);
  }
  const provider = providerById(cfg, L.providerId || cfg.classifier.providerId);
  const model = L.model || cfg.classifier.model;
  if (!provider || !model) {
    ev.error = 'no learner model';
    return record(ev);
  }
  const text = digest(s.messages, from, L.maxInputChars);
  const rel = related(cfg, text);
  const existing = rel.length ? '\n\nEXISTING NOTES (reuse the id to improve one):\n' + rel.map(g => `[${g.id}] ${g.title}\n${g.text}`).join('\n\n') : '';
  try {
    const r = await quickCompletion(
      provider,
      {
        model,
        temperature: 0.2,
        max_tokens: L.maxTokens,
        messages: [
          { role: 'system', content: L.systemPrompt },
          { role: 'user', content: text + existing }
        ],
        ...cfg.classifier.extraBody
      },
      L.timeoutMs
    );
    stats.bump('learnerCalls');
    stats.bump('learnerTokens', (r.usage?.prompt_tokens || 0) + (r.usage?.completion_tokens || 0));
    ev.ms = r.ms;
    ev.notes = applyNotes(cfg, parseJsonLoose(r.text).notes, text);
    analyzed.set(s.key, s.messages.length);
    if (analyzed.size > 1000) analyzed.delete(analyzed.keys().next().value);
  } catch (e) {
    ev.error = clip(String(e.message || e), 200);
  }
  return record(ev);
}

function record(ev) {
  const { title, ...rest } = ev;
  console.log('[learn] ' + JSON.stringify({ ...rest, title: title.slice(0, 60) }));
  events.unshift(ev);
  if (events.length > 50) events.length = 50;
  return ev;
}

// One analysis at a time: the learner model is small and requests are rare.
let chain = Promise.resolve();
function queue(cfg, s) {
  const p = chain.then(() => analyze(cfg, s));
  chain = p.catch(() => {});
  return p;
}

export function sweep(cfg, all = false) {
  const idleMs = (cfg.learning?.idleMin ?? 10) * 60e3;
  const due = [...sessions.values()].filter(s => all || Date.now() - s.lastAt >= idleMs);
  for (const s of due) sessions.delete(s.key);
  return Promise.all(due.map(s => queue(cfg, s)));
}

export function startLearner(getCfg) {
  setInterval(() => getCfg().learning?.enabled && sweep(getCfg()), 60e3).unref();
}

export function learnerState() {
  return {
    sessions: [...sessions.values()].map(s => ({ key: s.key, model: s.model, title: s.title, firstAt: s.firstAt, lastAt: s.lastAt, requests: s.requests, messages: s.messages.length, userTurns: userTurns(s.messages) })),
    events
  };
}

// Learned notes whose error pattern shows up in the latest user/tool messages.
// Plain substring match over the conversation tail: instant and free.
export function patternGuides(guides, messages, limit = 2) {
  const withPatterns = guides.filter(g => g.enabled && g.patterns?.length);
  if (!withPatterns.length) return [];
  const tail = messages
    .slice(-4)
    .filter(m => m.role === 'user' || m.role === 'tool')
    .map(m => textOf(m.content).slice(-8000))
    .join('\n')
    .toLowerCase();
  return withPatterns.filter(g => g.patterns.some(p => tail.includes(p.toLowerCase()))).slice(0, limit).map(g => g.id);
}
