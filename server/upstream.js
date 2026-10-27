// Thin client for any OpenAI-compatible /chat/completions endpoint.

export function providerById(cfg, id) {
  return cfg.providers.find(p => p.id === id) || null;
}

function url(provider, p) {
  return provider.baseUrl.replace(/\/+$/, '') + p;
}

function headers(provider) {
  const h = { 'content-type': 'application/json' };
  if (provider.apiKey) h.authorization = `Bearer ${provider.apiKey}`;
  return h;
}

export function chatRequest(provider, body, signal) {
  return fetch(url(provider, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(body),
    signal
  });
}

// Small one-shot completion with a hard timeout; returns { text, usage, ms }.
export async function quickCompletion(provider, body, timeoutMs) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await chatRequest(provider, { ...body, stream: false }, ctrl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    return { text: msg.content || '', usage: json.usage || null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(provider) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url(provider, '/models'), { headers: headers(provider), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.data || []).map(m => m.id).sort();
  } finally {
    clearTimeout(timer);
  }
}
