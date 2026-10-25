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
  await admin('/guides', 'POST', { id: 'human-test', title: 'Human voice', hint: 'casual', text: 'Talk like a friend.', stickyTriggers: ['как человек'] });
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
  assert.match(sys.content, /Talk like a friend/);
  assert.doesNotMatch(sys.content, /Focus for this request/);
  await admin('/guides/human-test', 'DELETE');
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

test('admin writes require JSON content type', async () => {
  const r = await fetch(BASE + '/api/keys', { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 415);
});
