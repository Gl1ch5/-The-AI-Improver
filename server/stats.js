import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'stats.json');
const LOG_SIZE = 300;

const empty = () => ({
  requests: 0,
  enhanced: 0,
  skipped: 0,
  streamed: 0,
  errors: 0,
  classifierCalls: 0,
  classifierErrors: 0,
  cacheHits: 0,
  classifierPromptTokens: 0,
  classifierCompletionTokens: 0,
  classifierMsTotal: 0,
  injectedTokensEst: 0,
  advisorCalls: 0,
  guideHits: {}
});

let totals = empty();
const log = [];

try {
  totals = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(FILE, JSON.stringify(totals));
  } catch {}
}, 5000).unref();

export const stats = {
  bump(k, n = 1) {
    totals[k] = (totals[k] || 0) + n;
    dirty = true;
  },
  classifierCall(usage, ms) {
    totals.classifierCalls++;
    totals.classifierMsTotal += ms;
    totals.classifierPromptTokens += usage?.prompt_tokens || 0;
    totals.classifierCompletionTokens += usage?.completion_tokens || 0;
    dirty = true;
  },
  guideHit(ids) {
    for (const id of ids) totals.guideHits[id] = (totals.guideHits[id] || 0) + 1;
    dirty = true;
  },
  record(entry) {
    log.unshift({ at: Date.now(), ...entry });
    if (log.length > LOG_SIZE) log.length = LOG_SIZE;
  },
  update(entry, patch) {
    Object.assign(entry, patch);
  },
  snapshot() {
    const llm = totals.classifierCalls || 1;
    return { ...totals, avgClassifierMs: Math.round(totals.classifierMsTotal / llm) };
  },
  logs(limit = 100) {
    return log.slice(0, limit);
  },
  reset() {
    totals = empty();
    log.length = 0;
    dirty = true;
  }
};

export const estTokens = s => Math.ceil((s || '').length / 3.6);
