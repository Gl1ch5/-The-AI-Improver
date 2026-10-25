#!/usr/bin/env node
// Quick A/B benchmark: same upstream model with and without AI Improver.
// Pulls small deterministic samples of public datasets from the HuggingFace
// datasets-server API (free, no account) and scores answers automatically.
//
//   node bench/run.mjs --base https://host/v1 --key sk-imp-... \
//     --models gemini-raw,gemini-improved --suites gsm8k,mmlupro,humaneval --n 50
//
// HumanEval executes model-written Python locally (python3, 10s timeout per task):
// run it on a machine where that is acceptable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const BASE = (args.base || 'http://127.0.0.1:3210/v1').replace(/\/+$/, '');
const KEY = args.key || process.env.IMPROVER_KEY || '';
const MODELS = (args.models || 'gemini-raw,gemini-improved').split(',');
const SUITES = (args.suites || 'gsm8k,mmlupro,humaneval').split(',');
const N = Number(args.n || 50);
const CONC = Number(args.concurrency || 4);
const SEED = Number(args.seed || 42);
const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname), '.cache');
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), 'results');

// ---------- datasets ----------

const DATASETS = {
  gsm8k: { dataset: 'openai/gsm8k', config: 'main', split: 'test', size: 1319 },
  mmlupro: { dataset: 'TIGER-Lab/MMLU-Pro', config: 'default', split: 'test', size: 12032 },
  humaneval: { dataset: 'openai/openai_humaneval', config: 'openai_humaneval', split: 'test', size: 164 }
};

function sampleIndices(size, n, seed) {
  // Deterministic Fisher-Yates with a small LCG so runs are comparable.
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const idx = [...Array(size).keys()];
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, size)).sort((a, b) => a - b);
}

async function loadRows(name) {
  const d = DATASETS[name];
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}-${SEED}-${N}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const i of sampleIndices(d.size, N, SEED)) {
    const u = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(d.dataset)}&config=${d.config}&split=${d.split}&offset=${i}&length=1`;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(u);
      if (r.ok) {
        rows.push((await r.json()).rows[0].row);
        break;
      }
      if (attempt >= 4) throw new Error(`HF ${r.status} for ${name}#${i}`);
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// ---------- suites: prompt + scorer ----------

const lastNumber = s => {
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
  return m ? Number(m.at(-1)) : NaN;
};

const SUITE = {
  gsm8k: {
    prompt: r => `Solve the problem. Finish with a final line "Answer: <number>".\n\n${r.question}`,
    score: (r, out) => {
      const gold = lastNumber(r.answer.split('####').at(-1));
      const m = out.match(/Answer:\s*\$?\s*(-?[\d,]+(?:\.\d+)?)/i);
      const got = m ? Number(m[1].replace(/,/g, '')) : lastNumber(out);
      return Math.abs(got - gold) < 1e-6;
    }
  },
  mmlupro: {
    prompt: r =>
      `${r.question}\n\n${r.options.map((o, i) => `${'ABCDEFGHIJ'[i]}. ${o}`).join('\n')}\n\nThink it through, then finish with a final line "Answer: <letter>".`,
    score: (r, out) => {
      const m = [...out.matchAll(/Answer:\s*\(?([A-J])\)?/gi)].at(-1);
      return !!m && m[1].toUpperCase() === r.answer;
    }
  },
  humaneval: {
    prompt: r => `Complete this Python function. Reply with the complete function (including imports it needs) in one \`\`\`python code block.\n\n\`\`\`python\n${r.prompt}\`\`\``,
    score: (r, out) => {
      const blocks = [...out.matchAll(/```(?:python|py)?\n([\s\S]*?)```/g)].map(m => m[1]);
      let code = blocks.find(b => b.includes(`def ${r.entry_point}`)) || blocks[0] || out;
      if (!code.includes(`def ${r.entry_point}`)) code = r.prompt + code;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-'));
      const file = path.join(dir, 't.py');
      fs.writeFileSync(file, `${r.prompt.match(/^(?:from|import) .*$/gm)?.join('\n') || ''}\n${code}\n\n${r.test}\n\ncheck(${r.entry_point})\n`);
      const res = spawnSync('python3', ['-I', file], { cwd: dir, timeout: 10000, stdio: 'ignore' });
      fs.rmSync(dir, { recursive: true, force: true });
      return res.status === 0;
    }
  }
};

// ---------- runner ----------

async function ask(model, content) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 4096, messages: [{ role: 'user', content }] }),
        signal: AbortSignal.timeout(240000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || {}, ms: Date.now() - started };
    } catch (e) {
      if (attempt >= 2) return { text: '', error: String(e.message || e), usage: {}, ms: Date.now() - started };
      await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const summary = [];
const details = {};
for (const suite of SUITES) {
  const rows = await loadRows(suite);
  for (const model of MODELS) {
    let done = 0;
    const results = await pool(rows, CONC, async r => {
      const a = await ask(model, SUITE[suite].prompt(r));
      const ok = !a.error && SUITE[suite].score(r, a.text);
      process.stderr.write(`\r${suite} ${model}: ${++done}/${rows.length}   `);
      return { ok, ms: a.ms, error: a.error, out: a.text.slice(-400), tokens: a.usage.completion_tokens || 0 };
    });
    process.stderr.write('\n');
    const correct = results.filter(x => x.ok).length;
    const errors = results.filter(x => x.error).length;
    const ms = results.map(x => x.ms).sort((a, b) => a - b);
    summary.push({
      suite,
      model,
      n: rows.length,
      correct,
      accuracy: +((correct / rows.length) * 100).toFixed(1),
      errors,
      medianMs: ms[Math.floor(ms.length / 2)],
      avgOutTokens: Math.round(results.reduce((s, x) => s + x.tokens, 0) / rows.length)
    });
    details[`${suite}/${model}`] = results;
  }
}

console.table(summary);
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(OUT, `${stamp}.json`), JSON.stringify({ base: BASE, models: MODELS, n: N, seed: SEED, summary, details }, null, 2));
console.log(`saved bench/results/${stamp}.json`);
