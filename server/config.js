import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUILTIN_GUIDES, DEFAULT_CLASSIFIER_PROMPT, DEFAULT_ADVISOR_PROMPT } from './guides.js';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const rid = (n = 6) => crypto.randomBytes(n).toString('hex');

function defaults() {
  return {
    sessionSecret: rid(32),
    requireApiKey: true,
    apiKeys: [{ id: rid(), name: 'default', key: 'sk-imp-' + rid(20), created: Date.now() }],
    providers: [
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '' }
    ],
    classifier: {
      enabled: true,
      providerId: 'openai',
      model: 'gpt-4.1-nano',
      temperature: 0,
      maxTokens: 160,
      timeoutMs: 2500,
      maxInputChars: 1200,
      cacheTtlSec: 900,
      skipTrivial: true,
      // Provider-specific knobs to switch thinking off, e.g. {"reasoning_effort":"minimal"},
      // {"enable_thinking":false} (Qwen), {"thinking":{"type":"disabled"}} (GLM/DeepSeek).
      extraBody: {},
      systemPrompt: DEFAULT_CLASSIFIER_PROMPT
    },
    advisor: {
      // Empty providerId/model = reuse the classifier model.
      providerId: '',
      model: '',
      maxTokens: 200,
      timeoutMs: 6000,
      systemPrompt: DEFAULT_ADVISOR_PROMPT
    },
    models: [
      {
        id: rid(),
        name: 'improved-gpt',
        enabled: true,
        providerId: 'openai',
        upstreamModel: 'gpt-4.1',
        systemPrompt: '',
        extraBody: {},
        enhance: { mode: 'pre', guides: true, critique: true, maxGuides: 2 }
      }
    ],
    guides: BUILTIN_GUIDES.map(g => ({ ...g, builtin: true, enabled: true }))
  };
}

let config = null;

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const base = defaults();
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = {
      ...base,
      ...saved,
      classifier: { ...base.classifier, ...saved.classifier },
      advisor: { ...base.advisor, ...saved.advisor }
    };
    // New built-in guides shipped in an update appear automatically.
    const have = new Set(config.guides.map(g => g.id));
    for (const g of BUILTIN_GUIDES) if (!have.has(g.id)) config.guides.push({ ...g, builtin: true, enabled: true });
  } else {
    config = base;
    applyEnvBootstrap(config);
  }
  saveConfig();
  return config;
}

// First-run convenience: lets a deploy pre-fill a provider without the UI.
function applyEnvBootstrap(c) {
  const env = process.env;
  if (env.UPSTREAM_NAME) c.providers[0].name = env.UPSTREAM_NAME;
  if (env.UPSTREAM_BASE_URL) c.providers[0].baseUrl = env.UPSTREAM_BASE_URL;
  if (env.UPSTREAM_API_KEY) c.providers[0].apiKey = env.UPSTREAM_API_KEY;
  if (env.CLASSIFIER_MODEL) c.classifier.model = env.CLASSIFIER_MODEL;
  if (env.TARGET_MODEL) c.models[0].upstreamModel = env.TARGET_MODEL;
  if (env.MODEL_NAME) c.models[0].name = env.MODEL_NAME;
}

export function getConfig() {
  return config;
}

export function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

export function resetGuide(id) {
  const orig = BUILTIN_GUIDES.find(g => g.id === id);
  const i = config.guides.findIndex(g => g.id === id);
  if (!orig || i < 0) return null;
  config.guides[i] = { ...orig, builtin: true, enabled: config.guides[i].enabled };
  saveConfig();
  return config.guides[i];
}

export const defaultPrompts = { classifier: DEFAULT_CLASSIFIER_PROMPT, advisor: DEFAULT_ADVISOR_PROMPT };

// Admin password: env ADMIN_PASSWORD wins; otherwise one is generated once and
// written to data/admin-password.txt so the operator can read it on the server.
export function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const p = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, rid(9) + '\n', { mode: 0o600 });
    console.log(`[improver] generated admin password in ${p}`);
  }
  return fs.readFileSync(p, 'utf8').trim();
}
