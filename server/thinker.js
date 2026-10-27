import crypto from 'node:crypto';
import { providerById, quickCompletion } from './upstream.js';
import { snippet } from './classifier.js';

// "Think" mode: before the main model answers, the fast model thinks twice.
// Pass 1 drafts an analysis of the request (runs in parallel with the
// classifier), pass 2 checks that draft against the router's critique and
// rewrites it into a short brief. The brief goes into the main model's notes.

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
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
}

export function clearThinkerCache() {
  cache.clear();
}

function setup(cfg, messages) {
  const t = cfg.thinking;
  const provider = providerById(cfg, t.providerId || cfg.classifier.providerId);
  const model = t.model || cfg.classifier.model;
  const snip = snippet(messages, t.maxInputChars);
  const key = crypto.createHash('sha1').update([model, t.draftPrompt, t.reviewPrompt, snip].join('\0')).digest('hex');
  return { t, provider, model, snip, key };
}

async function ask(cfg, s, system, user, maxTokens, stats) {
  const r = await quickCompletion(
    s.provider,
    {
      model: s.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...cfg.classifier.extraBody
    },
    s.t.timeoutMs
  );
  stats?.classifierCall(r.usage, r.ms);
  stats?.bump('thinkCalls');
  return r;
}

// Pass 1. Returns a promise so it can run alongside classify(); null when the
// thinker is not configured or the answer is already cached.
export function startDraft(cfg, messages, stats) {
  const s = setup(cfg, messages);
  if (!s.provider || !s.model || cacheGet(s.key, cfg.classifier.cacheTtlSec * 1000)) return null;
  return ask(cfg, s, s.t.draftPrompt, s.snip, s.t.maxTokens, stats).catch(e => ({ error: String(e.message || e) }));
}

// Pass 2, plus caching. `draft` is what startDraft() returned. With cacheOnly
// (agent steps after a tool result) no model is called: the brief from the
// turn's start is reused so the system prompt stays stable across the loop.
export async function finishThinking(cfg, messages, cls, draft, stats, cacheOnly = false) {
  const s = setup(cfg, messages);
  const cached = cacheGet(s.key, cfg.classifier.cacheTtlSec * 1000);
  if (cached) return { ...cached, source: 'cache', ms: 0 };
  if (cacheOnly || !s.provider || !s.model) return { text: '', source: 'off', ms: 0 };

  const started = Date.now();
  const d = draft ? await draft : await ask(cfg, s, s.t.draftPrompt, s.snip, s.t.maxTokens, stats).catch(e => ({ error: String(e.message || e) }));
  if (d.error || !d.text?.trim()) {
    stats?.bump('thinkErrors');
    return { text: '', source: 'error', error: d.error || 'empty draft', ms: Date.now() - started };
  }
  const draftText = d.text.trim().slice(0, 4000);
  let text = draftText;
  let error;
  try {
    const user = `Request:\n${s.snip}\n\n${cls.critique ? `Router critique: ${cls.critique}\n\n` : ''}Draft analysis:\n${draftText}`;
    const r = await ask(cfg, s, s.t.reviewPrompt, user, s.t.maxTokens, stats);
    if (r.text.trim()) text = r.text.trim();
  } catch (e) {
    // The unchecked draft is still better than nothing.
    stats?.bump('thinkErrors');
    error = String(e.message || e);
  }
  const result = { text: text.slice(0, 3000), draft: draftText };
  if (!error) cachePut(s.key, result);
  return { ...result, source: error ? 'draft-only' : 'llm', error, ms: Date.now() - started };
}
