import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 39211;
const MOCK_PORT = 39212;
const BASE = `http://127.0.0.1:${PORT}`;
let proc, mock, cookie, apiKey;
const seen = [];
const learnerInputs = [];
const thinkReviews = [];

// Fake OpenAI-compatible upstream that plays classifier, advisor and main model.
function startMock() {
  mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push(body);
    const sys = body.messages[0]?.role === 'system' ? body.messages[0].content : '';
    if (sys.includes('request router') && body.messages[1].content.includes('is_prime')) {
      return res.end(JSON.stringify({ choices: [{ message: { content: '{"g":[],"c":"trivial","t":"","l":"ru"}' } }] }));
    }
    if (sys.includes('request router')) {
      return res.end(JSON.stringify({
        choices: [{ message: { content: '{"g":["web-design"],"c":"complex","t":"Needs a clear hero and real copy.","l":"ru"}' } }],
        usage: { prompt_tokens: 300, completion_tokens: 30 }
      }));
    }
    if (sys.includes('reusable working notes')) {
      learnerInputs.push(body.messages[1].content);
      const note = {
        id: 'godot-null-node-access',
        topic: 'godot',
        title: 'Godot: null node access',
        hint: 'Godot errors on missing nodes',
        keywords: ['godot', 'gdscript', 'get_node'],
        patterns: ['Invalid get index', 'made-up error that never happened'],
        text: '- Resolve child nodes with @onready var x = $Path and check is_instance_valid() before use.\n- Invalid get index on null means the node path is wrong or the node was freed; print get_path() and fix the scene tree instead of guarding every access.'
      };
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes: [note] }) } }] }));
    }
    if (sys.includes('think a request through')) {
      return res.end(JSON.stringify({ choices: [{ message: { content: '- 17*23 = 401' } }] }));
    }
    if (sys.includes('check a draft analysis')) {
      thinkReviews.push(body.messages[1].content);
      return res.end(JSON.stringify({ choices: [{ message: { content: '- 17*23 = 391, not 401' } }] }));
    }
    if (sys.includes('strict, fast reviewer')) {
      return res.end(JSON.stringify({ choices: [{ message: { content: '- Add a pricing section' } }] }));
    }
    const hasTool = (body.tools || []).some(t => t.function.name === 'quality_review');
    const toolMsg = body.messages.find(m => m.role === 'tool');
    const reply = `guided=${sys.includes('Web / UI design')} advice=${toolMsg ? toolMsg.content : 'none'}`;
    if (!body.stream) {
      if (hasTool && !toolMsg) {
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'quality_review', arguments: '{"plan":"hero+cards"}' } }] }, finish_reason: 'tool_calls' }] }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (hasTool && !toolMsg) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'quality_review', arguments: '' } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"plan":"hero"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      for (const part of reply.match(/.{1,8}/g)) send({ choices: [{ index: 0, delta: { content: part } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise(r => mock.listen(MOCK_PORT, r));
}

async function admin(p, method = 'GET', body) {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { cookie, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

function chat(body) {
  return fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function readSse(res) {
  const text = await res.text();
  const out = { content: '', toolCalls: [], finish: [], done: text.includes('[DONE]') };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    const ch = JSON.parse(line.slice(6)).choices?.[0];
    if (!ch) continue;
    out.content += ch.delta?.content || '';
    if (ch.delta?.tool_calls) out.toolCalls.push(...ch.delta.tool_calls);
    if (ch.finish_reason) out.finish.push(ch.finish_reason);
  }
  return out;
}

before(async () => {
  await startMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'improver-'));
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: 'test-pass' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pass' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await admin('/state');
  apiKey = state.apiKeys[0].key;
  await admin('/providers/openai', 'PUT', { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'x' });
  // Login remembered 127.0.0.1; switch that off so auth tests see a stranger.
  await admin('/general', 'PUT', { rememberIp: false });
});

after(() => {
  proc?.kill();
  mock?.close();
});

test('rejects wrong admin password and missing api key', async () => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(r.status, 401);
  const c = await fetch(BASE + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(c.status, 401);
});

test('lists virtual models', async () => {
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
  const j = await r.json();
  assert.deepEqual(j.data.map(m => m.id), ['improved-gpt']);
});

test('pre mode injects guide and critique, streams through', async () => {
  seen.length = 0;
  const res = await chat({ model: 'improved-gpt', stream: true, messages: [{ role: 'user', content: 'Сделай сайт для кофейни' }] });
  assert.equal(res.status, 200);
  const out = await readSse(res);
  assert.equal(out.content, 'guided=true advice=none');
  assert.ok(out.done);
  const main = seen.find(b => b.model === 'gpt-4.1');
  assert.match(main.messages[0].content, /Needs a clear hero/);
  assert.equal(main.messages.at(-1).content, 'Сделай сайт для кофейни');
});

test('trivial message skips classifier entirely', async () => {
  seen.length = 0;
  const res = await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: 'привет!' }] });
  const j = await res.json();
  assert.equal(j.choices[0].message.content, 'guided=false advice=none');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages[0].role, 'user');
});

test('classification is cached', async () => {
  seen.length = 0;
  await (await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: 'Сделай сайт для кофейни' }] })).json();
  assert.equal(seen.length, 1, 'only the main model is called');
});

test('client system prompt is preserved and model prompt is prepended', async () => {
  const state = await admin('/state');
  await admin('/models/' + state.models[0].id, 'PUT', { systemPrompt: 'You are Nova.' });
  seen.length = 0;
  await (await chat({ model: 'improved-gpt', messages: [{ role: 'system', content: 'Client rules' }, { role: 'user', content: 'Сделай сайт для кофейни' }] })).json();
  const sys = seen.at(-1).messages[0].content;
  assert.ok(sys.indexOf('You are Nova.') < sys.indexOf('Client rules'));
  assert.ok(sys.indexOf('Client rules') < sys.indexOf('Internal working notes'));
});

test('advisor tool round-trip is invisible to a streaming client', async () => {
  const state = await admin('/state');
  await admin('/models/' + state.models[0].id, 'PUT', { enhance: { mode: 'both', guides: true, critique: true, maxGuides: 2 } });
  const res = await chat({ model: 'improved-gpt', stream: true, messages: [{ role: 'user', content: 'Сделай сайт для барбершопа' }] });
  const out = await readSse(res);
  assert.equal(out.content, 'guided=true advice=- Add a pricing section');
  assert.equal(out.toolCalls.length, 0);
  assert.deepEqual(out.finish, ['stop']);
  const first = seen.find(b => b.tools?.some(t => t.function.name === 'quality_review'));
  assert.equal(first.tool_choice.function.name, 'quality_review');
  const second = seen.findLast(b => b.messages.some(m => m.role === 'tool'));
  assert.equal(second.tools, undefined);
  assert.equal(second.tool_choice, undefined);
});

test('advisor tool round-trip works without streaming', async () => {
  const res = await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: 'Сделай сайт для студии йоги' }] });
  const j = await res.json();
  assert.equal(j.choices[0].message.content, 'guided=true advice=- Add a pricing section');
  assert.equal(j.choices[0].message.tool_calls, undefined);
});

test('agent continuation after a tool result does not offer the advisor again', async () => {
  seen.length = 0;
  const res = await chat({
    model: 'improved-gpt',
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
    messages: [
      { role: 'user', content: 'Сделай сайт для барбершопа' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file contents' }
    ]
  });
  await res.json();
  const main = seen.at(-1);
  assert.deepEqual(main.tools.map(t => t.function.name), ['read_file']);
  assert.match(main.messages[0].content, /Web \/ UI design/, 'guides still apply on continuation steps');
});

test('a real task the classifier calls trivial still gets guidance', async () => {
  seen.length = 0;
  await (await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: 'Напиши на Python функцию is_prime(n), только код' }] })).json();
  const main = seen.at(-1);
  assert.match(main.messages[0].content, /General coding quality/);
});

test('a style asked for once sticks for the rest of the dialog, even on small talk', async () => {
  seen.length = 0;
  await (await chat({
    model: 'improved-gpt',
    messages: [
      { role: 'user', content: 'Давай общайся как человек' },
      { role: 'assistant', content: 'Ок' },
      { role: 'user', content: 'привет' }
    ]
  })).json();
  const sys = seen.at(-1).messages[0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /Talk like a human|natural spoken Russian/i);
  assert.doesNotMatch(sys.content, /Focus for this request/);
});

test('think mode: the fast model drafts, checks its draft, and the main model gets the result', async () => {
  const state = await admin('/state');
  await admin('/models/' + state.models[0].id, 'PUT', { enhance: { mode: 'think', guides: true, critique: true, maxGuides: 2 } });
  seen.length = 0;
  const q = 'Сделай лендинг и посчитай 17*23 для цены';
  await (await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: q }] })).json();
  const sys = seen.at(-1).messages[0].content;
  assert.match(sys, /Prepared analysis[\s\S]*391, not 401/);
  assert.doesNotMatch(sys, /= 401$/m, 'the unchecked draft is not passed on');
  assert.match(sys, /Web \/ UI design/, 'guides still apply');
  assert.match(thinkReviews.at(-1), /Draft analysis:\n- 17\*23 = 401/);
  assert.match(thinkReviews.at(-1), /Router critique: Needs a clear hero/);
  assert.equal(seen.length, 4, 'classifier + draft + review + main');

  // An agent step after a tool result reuses the brief without new model calls.
  seen.length = 0;
  await (await chat({
    model: 'improved-gpt',
    messages: [
      { role: 'user', content: q },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' }
    ]
  })).json();
  assert.equal(seen.length, 1);
  assert.match(seen[0].messages[0].content, /391, not 401/);

  // Small talk skips thinking entirely.
  seen.length = 0;
  await (await chat({ model: 'improved-gpt', messages: [{ role: 'user', content: 'спасибо!' }] })).json();
  assert.equal(seen.length, 1);
  await admin('/models/' + state.models[0].id, 'PUT', { enhance: { mode: 'pre', guides: true, critique: true, maxGuides: 2 } });
});

test('unknown model returns OpenAI-style 404', async () => {
  const res = await chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.type, 'model_not_found');
});

test('journal records the routing decision', async () => {
  const { logs } = await admin('/logs');
  const hit = logs.find(l => l.guides?.includes('web-design'));
  assert.ok(hit, 'a logged request carries its guides');
  assert.equal(hit.status, 200);
  assert.equal(typeof hit.totalMs, 'number');
});

test('a remembered IP opens the panel without a password until logout', async () => {
  const me = () => fetch(BASE + '/api/me').then(r => r.json());
  assert.equal((await me()).admin, false);
  await admin('/general', 'PUT', { rememberIp: true });
  const state = await admin('/state');
  assert.ok(state.trustedIps.some(t => t.ip === state.myIp));
  assert.equal((await me()).admin, true);
  await fetch(BASE + '/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal((await me()).admin, false);
  await admin('/general', 'PUT', { rememberIp: false });
});

test('forged X-Forwarded-For is ignored without TRUST_PROXY', async () => {
  const r = await fetch(BASE + '/api/state', { headers: { cookie, 'x-forwarded-for': '6.6.6.6' } });
  assert.notEqual((await r.json()).myIp, '6.6.6.6');
});

test('admin writes require JSON content type', async () => {
  const r = await fetch(BASE + '/api/keys', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 415);
});

test('learning mode turns a finished session into a note that fires on its error', async () => {
  const state = await admin('/state');
  await admin('/models/' + state.models[0].id, 'PUT', { enhance: { mode: 'pre', guides: true, critique: true, maxGuides: 2 } });
  await admin('/learning', 'PUT', { enabled: true });
  const session = [
    { role: 'user', content: 'Сделай игру на Godot: игрок прыгает по платформам' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'run_game', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'r1', content: "loaded scene\nSCRIPT ERROR: Invalid get index 'position' (on base: 'null instance').\n   at: player.gd:12" },
    { role: 'assistant', content: 'Исправил путь к узлу.' },
    { role: 'user', content: 'Не обвешивай всё проверками на null, найди причину' }
  ];
  await (await chat({ model: 'improved-gpt', messages: session.slice(0, 3) })).json();
  await (await chat({ model: 'improved-gpt', messages: session })).json();
  const pending = await admin('/learning');
  assert.equal(pending.sessions.length, 1);
  assert.equal(pending.sessions[0].userTurns, 2);

  const done = await admin('/learning/flush', 'POST', {});
  assert.deepEqual(done.events[0].notes, ['godot-null-node-access']);
  const digest = learnerInputs.at(-1);
  assert.match(digest, /TASK: Сделай игру на Godot/);
  assert.match(digest, /TOOL ERROR: SCRIPT ERROR: Invalid get index/);
  assert.match(digest, /USER: Не обвешивай/);
  assert.doesNotMatch(digest, /loaded scene/, 'only error lines of tool output');

  const note = (await admin('/state')).guides.find(g => g.id === 'godot-null-node-access');
  assert.equal(note.category, 'learned');
  assert.deepEqual(note.patterns, ['Invalid get index'], 'patterns that never occurred are dropped');

  // Same error in a new session's tool output attaches the note without the classifier.
  seen.length = 0;
  await (await chat({
    model: 'improved-gpt',
    messages: [
      { role: 'user', content: 'Почини врага' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r2', type: 'function', function: { name: 'run_game', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'r2', content: "Invalid get index 'health' (on base: 'null instance')" }
    ]
  })).json();
  assert.match(seen.at(-1).messages[0].content, /Godot: null node access/);

  // A resumed session is only learned from its new messages.
  await (await chat({ model: 'improved-gpt', messages: session })).json();
  const again = await admin('/learning/flush', 'POST', {});
  const resumed = again.events.find(e => e.title.startsWith('Сделай игру'));
  assert.equal(resumed.skipped, 'short');
  await admin('/learning', 'PUT', { enabled: false });
});

test('two unrelated chats with the same first message are learned separately', async () => {
  await admin('/learning', 'PUT', { enabled: true });
  const a = [{ role: 'user', content: 'who are you?' }, { role: 'assistant', content: 'I am a bot.' }, { role: 'user', content: 'Расскажи про Python' }];
  const b = [{ role: 'user', content: 'who are you?' }, { role: 'assistant', content: 'I am an agent.' }, { role: 'user', content: 'Сделай лендинг' }];
  await (await chat({ model: 'improved-gpt', messages: a })).json();
  await (await chat({ model: 'improved-gpt', messages: b })).json();
  const pending = await admin('/learning');
  assert.equal(pending.sessions.filter(x => x.title === 'who are you?').length, 2);
  await admin('/learning/flush', 'POST', {});
  await admin('/learning', 'PUT', { enabled: false });
});
