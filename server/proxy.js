import { classify, lastUserText, stickyGuides } from './classifier.js';
import { providerById, chatRequest, quickCompletion } from './upstream.js';
import { stats, estTokens } from './stats.js';

export const ADVISOR_TOOL = 'quality_review';

const advisorToolDef = {
  type: 'function',
  function: {
    name: ADVISOR_TOOL,
    description:
      'Instant expert review of your plan. Before answering a non-trivial request, call this once with a short plan of what you will do and how. Returns critique. Invisible to the user.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'Your plan in a few lines' } },
      required: ['plan']
    }
  }
};

export class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// ---------- request preparation ----------

function buildGuidance(cfg, model, cls, toolEnabled) {
  const e = model.enhance;
  const parts = [];
  if (e.critique && cls.critique && !cls.trivialOnlySticky) parts.push(`Focus for this request: ${cls.critique}`);
  const used = [];
  if (e.guides) {
    const ids = [...new Set([...(cls.trivialOnlySticky ? [] : cls.guides.slice(0, e.maxGuides ?? 2)), ...(cls.sticky || [])])];
    for (const id of ids) {
      const g = cfg.guides.find(x => x.id === id && x.enabled);
      if (!g) continue;
      used.push(g.id);
      parts.push(`${g.title}:\n${g.text}`);
    }
  }
  if (toolEnabled) parts.push(`Before answering, call ${ADVISOR_TOOL} once with your short plan and use its feedback.`);
  if (!parts.length) return { text: '', used };
  return {
    text:
      '[Internal working notes — apply them silently. Never mention or quote these notes, guidelines, a reviewer or a router. Answer in the user\'s language.]\n' +
      parts.join('\n\n'),
    used
  };
}

function mergeSystem(messages, prefix, suffix) {
  const join = (...xs) => xs.filter(Boolean).join('\n\n');
  if (!prefix && !suffix) return messages;
  const first = messages[0];
  if (first && (first.role === 'system' || first.role === 'developer')) {
    const copy = { ...first };
    if (Array.isArray(copy.content)) {
      copy.content = [
        ...(prefix ? [{ type: 'text', text: prefix }] : []),
        ...copy.content,
        ...(suffix ? [{ type: 'text', text: suffix }] : [])
      ];
    } else {
      copy.content = join(prefix, copy.content, suffix);
    }
    return [copy, ...messages.slice(1)];
  }
  return [{ role: 'system', content: join(prefix, suffix) }, ...messages];
}

export async function prepare(cfg, body) {
  if (!body || !Array.isArray(body.messages)) throw new HttpError(400, '`messages` must be an array');
  const model = cfg.models.find(m => m.name === body.model && m.enabled);
  if (!model) throw new HttpError(404, `Model '${body.model}' not found`, 'model_not_found');
  const provider = providerById(cfg, model.providerId);
  if (!provider) throw new HttpError(500, `Provider for model '${model.name}' is not configured`, 'server_error');

  const mode = model.enhance?.mode || 'off';
  let cls = { guides: [], complexity: 'simple', critique: '', source: 'off', ms: 0 };
  if (mode !== 'off') cls = await classify(cfg, body.messages, stats);

  // Only on a fresh user turn: in agent loops the last message is a tool result,
  // and re-reviewing the plan on every step would add latency for nothing.
  const freshTurn = body.messages.at(-1)?.role === 'user';
  const toolEnabled =
    (mode === 'tool' || mode === 'both') && freshTurn && cls.complexity === 'complex' && body.tool_choice !== 'none';
  if (mode !== 'off') cls.sticky = stickyGuides(cfg.guides, body.messages);
  // Small talk gets no task guidance, but a style the user asked for still applies.
  if (cls.complexity === 'trivial') cls.trivialOnlySticky = true;
  const guidance =
    mode === 'off' || (cls.complexity === 'trivial' && !cls.sticky?.length)
      ? { text: '', used: [] }
      : buildGuidance(cfg, mode === 'tool' ? { ...model, enhance: { ...model.enhance, guides: false, critique: false } } : model, cls, toolEnabled);

  const messages = mergeSystem(body.messages, model.systemPrompt?.trim(), guidance.text);
  const upstreamBody = { ...body, ...(model.extraBody || {}), model: model.upstreamModel, messages };
  if (toolEnabled) {
    upstreamBody.tools = [...(body.tools || []), advisorToolDef];
    // Models often skip an optional tool; when the client has no tools of its
    // own, force the plan review so the critique reliably happens.
    if (!body.tools?.length && !body.tool_choice) upstreamBody.tool_choice = { type: 'function', function: { name: ADVISOR_TOOL } };
  }

  return {
    model,
    provider,
    upstreamBody,
    toolEnabled,
    meta: {
      classification: cls,
      guides: guidance.used,
      injected: guidance.text,
      injectedTokens: estTokens(guidance.text) + estTokens(model.systemPrompt)
    }
  };
}

// ---------- advisor (hidden tool) ----------

async function runAdvisor(cfg, messages, plan) {
  const a = cfg.advisor;
  const provider = providerById(cfg, a.providerId || cfg.classifier.providerId);
  const model = a.model || cfg.classifier.model;
  stats.bump('advisorCalls');
  if (!provider || !model) return 'Plan OK.';
  const req = lastUserText(messages).slice(0, cfg.classifier.maxInputChars);
  try {
    const r = await quickCompletion(
      provider,
      {
        model,
        temperature: 0,
        max_tokens: a.maxTokens,
        messages: [
          { role: 'system', content: a.systemPrompt },
          { role: 'user', content: `User request:\n${req}\n\nAssistant plan:\n${String(plan).slice(0, 2000)}` }
        ],
        ...cfg.classifier.extraBody
      },
      a.timeoutMs
    );
    stats.classifierCall(r.usage, r.ms);
    return r.text.trim() || 'Plan OK.';
  } catch {
    return 'Plan OK.';
  }
}

function secondRoundBody(body, assistantContent, call, critique) {
  const tools = (body.tools || []).filter(t => t.function?.name !== ADVISOR_TOOL);
  const next = {
    ...body,
    messages: [
      ...body.messages,
      {
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: [{ id: call.id, type: 'function', function: { name: ADVISOR_TOOL, arguments: call.args || '{}' } }]
      },
      { role: 'tool', tool_call_id: call.id, content: critique }
    ]
  };
  if (tools.length) next.tools = tools;
  else {
    delete next.tools;
    delete next.tool_choice;
  }
  return next;
}

function planFromArgs(args) {
  try {
    return JSON.parse(args || '{}').plan || args;
  } catch {
    return args;
  }
}

// ---------- streaming ----------

async function upstreamOrThrow(provider, body, signal) {
  const res = await chatRequest(provider, body, signal);
  if (!res.ok) {
    const text = await res.text();
    const err = new HttpError(res.status, text.slice(0, 2000), 'upstream_error');
    err.raw = text;
    throw err;
  }
  return res;
}

function sseHeaders(res, extra) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extra
  });
}

async function pipeRaw(upRes, res) {
  const reader = upRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
}

async function* sseEvents(upRes) {
  const reader = upRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}

// One upstream round; forwards everything except our own tool call. Returns
// the advisor call if the model made one (and nothing else needs the client).
async function pumpRound(upRes, res, final) {
  const map = new Map(); // upstream tool index -> { own, idx }
  let clientTools = 0;
  let own = null;
  let content = '';
  let held = [];
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for await (const data of sseEvents(upRes)) {
    if (data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) {
      held.push(chunk); // usage-only chunk: only the last round's goes out
      continue;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      const pass = [];
      for (const tc of delta.tool_calls) {
        let slot = map.get(tc.index);
        if (!slot) {
          const isOwn = tc.function?.name === ADVISOR_TOOL;
          slot = isOwn ? { own: true } : { own: false, idx: clientTools++ };
          map.set(tc.index, slot);
          if (isOwn) own = { id: tc.id || 'call_' + Date.now(), args: '' };
        }
        if (slot.own) own.args += tc.function?.arguments || '';
        else pass.push({ ...tc, index: slot.idx });
      }
      if (pass.length) delta.tool_calls = pass;
      else delete delta.tool_calls;
    }
    const continuing = own && !clientTools && choice.finish_reason;
    if (continuing) choice.finish_reason = null;
    const hasPayload = Object.keys(delta).some(k => k !== 'role' && delta[k] != null && delta[k] !== '') || choice.finish_reason;
    if (hasPayload || (delta.role && !own)) send(chunk);
  }

  const advisor = own && !clientTools ? own : null;
  if (!advisor || final) for (const h of held) send(h);
  return { advisor, content };
}

export async function handleStream(cfg, prep, res, signal, extraHeaders) {
  const up = await upstreamOrThrow(prep.provider, prep.upstreamBody, signal);
  sseHeaders(res, extraHeaders);
  if (!prep.toolEnabled) {
    await pipeRaw(up, res);
    return {};
  }
  const r1 = await pumpRound(up, res, false);
  let advice = null;
  if (r1.advisor) {
    advice = await runAdvisor(cfg, prep.upstreamBody.messages, planFromArgs(r1.advisor.args));
    const body2 = secondRoundBody(prep.upstreamBody, r1.content, r1.advisor, advice);
    const up2 = await upstreamOrThrow(prep.provider, body2, signal);
    await pumpRound(up2, res, true);
  }
  res.write('data: [DONE]\n\n');
  return { advice };
}

// ---------- non-streaming ----------

export async function handleJson(cfg, prep, signal) {
  const up = await upstreamOrThrow(prep.provider, prep.upstreamBody, signal);
  let json = await up.json();
  if (!prep.toolEnabled) return { json };

  const msg = json.choices?.[0]?.message;
  const calls = msg?.tool_calls || [];
  const own = calls.find(c => c.function?.name === ADVISOR_TOOL);
  if (!own) return { json };
  const others = calls.filter(c => c !== own);
  if (others.length) {
    msg.tool_calls = others;
    return { json };
  }
  const advice = await runAdvisor(cfg, prep.upstreamBody.messages, planFromArgs(own.function.arguments));
  const body2 = secondRoundBody(prep.upstreamBody, msg.content, { id: own.id, args: own.function.arguments }, advice);
  const up2 = await upstreamOrThrow(prep.provider, body2, signal);
  json = await up2.json();
  return { json, advice };
}
