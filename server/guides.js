// Built-in guidance library. These are not "skills" the model is told about —
// they are compact, imperative working notes that get silently merged into the
// system context when the classifier decides they are relevant.
// They live in server/library/<category>.json; keep every text short, since
// each one costs input tokens on every matching request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBRARY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'library');

export const CATEGORIES = ['behavior', 'writing', 'design', 'coding', 'reasoning', 'domains'];

export const BUILTIN_GUIDES = CATEGORIES.flatMap(category => {
  const file = path.join(LIBRARY_DIR, `${category}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(({ sources, ...g }) => ({ ...g, category }));
});

// The default critic prompt. Short on purpose: it is sent with every classified
// request. {{CATALOG}} is replaced with "id: hint" lines of enabled guides.
export const DEFAULT_CLASSIFIER_PROMPT = `You are a fast request router and critic for another AI assistant. You never answer the user.
Read the user's latest request (and brief context) and output ONLY compact JSON:
{"g":["guide ids, 0-2, most relevant first"],"c":"one of: trivial|simple|complex","t":"critique: 1-3 short sentences on what a strong answer must do and the most likely mistakes to avoid for THIS request","l":"language code of the user's message"}
Rules: be specific to the request, no generic advice; "trivial" ONLY for pure greetings/thanks/small talk with no task (then g=[] and t=""); any request to write, fix, read, explain or make something is at least "simple"; "complex" = multi-part builds, architecture, long code; never exceed 60 words in "t".
Guides:
{{CATALOG}}`;

// Prompt used when the main model calls the hidden advisor tool with its plan.
export const DEFAULT_ADVISOR_PROMPT = `You are a strict, fast reviewer. Another AI assistant shows you its plan for answering a user. Reply with 1-4 terse bullet points: concrete flaws, missing steps or risks in the plan, and how to fix them. If the plan is good, say "Plan OK" plus at most one improvement. No preamble.`;
