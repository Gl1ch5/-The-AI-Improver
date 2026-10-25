import crypto from 'node:crypto';
import { providerById, quickCompletion } from './upstream.js';

// ---------- message helpers ----------

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
  return '';
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return textOf(messages[i].content);
  return '';
}

// Compact view of the conversation for the classifier: the latest request in
// full (clipped) plus a one-line hint of the previous user turn for follow-ups
// like "now make it blue". Nothing else — that is what keeps it cheap.
export function snippet(messages, maxChars) {
  const users = messages.filter(m => m.role === 'user').map(m => textOf(m.content));
  const last = users.at(-1) || '';
  const prev = users.length > 1 ? users.at(-2) : '';
  const clip = (s, n) => (s.length > n ? s.slice(0, Math.floor(n * 0.7)) + ' … ' + s.slice(-Math.floor(n * 0.3)) : s);
  let out = clip(last, maxChars);
  if (prev) out = `[previous user turn: ${clip(prev, 160)}]\n${out}`;
  return out;
}

// ---------- local heuristics (free, ~0ms) ----------

const TRIVIAL = /^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|nice|bye|привет|здравствуй(те)?|хай|спасибо|спс|благодарю|ок|окей|хорошо|понял|ясно|круто|пока|добрый (день|вечер|утро))[\s!.,)?]*$/i;

export function isTrivial(text) {
  const t = text.trim();
  return t.length === 0 || (t.length < 40 && TRIVIAL.test(t));
}

export function detectLang(text) {
  const cyr = (text.match(/[а-яё]/gi) || []).length;
  const lat = (text.match(/[a-z]/gi) || []).length;
  return cyr > lat ? 'ru' : 'en';
}

export function heuristicClassify(text, guides, maxGuides = 2) {
  const t = text.toLowerCase();
  const scored = guides
    .map(g => ({ id: g.id, s: (g.keywords || []).reduce((n, k) => n + (t.includes(k.toLowerCase()) ? 1 : 0), 0) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxGuides)
    .map(x => x.id);
  return {
    guides: scored,
    complexity: isTrivial(text) ? 'trivial' : text.length > 400 || scored.length ? 'complex' : 'simple',
    critique: '',
    lang: detectLang(text),
    source: 'heuristic'
  };
}

// ---------- LLM classifier ----------

const cache = new Map();

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cachePut(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
}

export function catalog(guides) {
  return guides.map(g => `${g.id}: ${g.hint || g.title}`).join('\n');
}

export function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in classifier output');
  return JSON.parse(m[0]);
}

export async function classify(cfg, messages, stats) {
  const c = cfg.classifier;
  const guides = cfg.guides.filter(g => g.enabled);
  const text = lastUserText(messages);

  if (c.skipTrivial && isTrivial(text)) return { guides: [], complexity: 'trivial', critique: '', lang: detectLang(text), source: 'skip', ms: 0 };

  const provider = providerById(cfg, c.providerId);
  if (!c.enabled || !provider || !c.model) return { ...heuristicClassify(text, guides), ms: 0 };

  const snip = snippet(messages, c.maxInputChars);
  const system = c.systemPrompt.replace('{{CATALOG}}', catalog(guides));
  const key = crypto.createHash('sha1').update(c.model + '\0' + system + '\0' + snip).digest('hex');
  const cached = cacheGet(key, c.cacheTtlSec * 1000);
  if (cached) {
    stats?.bump('cacheHits');
    return { ...cached, source: 'cache', ms: 0 };
  }

  try {
    const r = await quickCompletion(
      provider,
      {
        model: c.model,
        temperature: c.temperature,
        max_tokens: c.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: snip }
        ],
        ...c.extraBody
      },
      c.timeoutMs
    );
    stats?.classifierCall(r.usage, r.ms);
    const j = parseJsonLoose(r.text);
    const known = new Set(guides.map(g => g.id));
    let picked = (Array.isArray(j.g) ? j.g : []).filter(id => known.has(id));
    let complexity = ['trivial', 'simple', 'complex'].includes(j.c) ? j.c : 'simple';
    // Small models over-use "trivial" for short real tasks ("write is_prime").
    // Only genuine small talk may skip enhancement.
    if (complexity === 'trivial' && !isTrivial(text)) {
      complexity = 'simple';
      if (!picked.length) picked = heuristicClassify(text, guides).guides;
    }
    const result = {
      guides: picked,
      complexity,
      critique: typeof j.t === 'string' ? j.t.trim().slice(0, 600) : '',
      lang: typeof j.l === 'string' ? j.l : detectLang(text),
      source: 'llm'
    };
    cachePut(key, result);
    return { ...result, ms: r.ms };
  } catch (e) {
    stats?.bump('classifierErrors');
    return { ...heuristicClassify(text, guides), source: 'heuristic-fallback', error: String(e.message || e), ms: 0 };
  }
}

export function clearClassifierCache() {
  cache.clear();
}
