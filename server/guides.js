// Built-in guidance library. These are not "skills" the model is told about —
// they are compact, imperative working notes that get silently merged into the
// system context when the classifier decides they are relevant.
// Keep every text short: each one costs input tokens on every matching request.

export const BUILTIN_GUIDES = [
  {
    id: 'web-design',
    title: 'Web / UI design',
    hint: 'landing pages, websites, UI, layouts, styling, CSS, visual design',
    keywords: ['сайт', 'лендинг', 'дизайн', 'интерфейс', 'вёрстк', 'верстк', 'css', 'tailwind', 'landing', 'website', 'web page', 'ui', 'ux', 'layout', 'html', 'стил', 'кнопк', 'figma'],
    text: `Design with intent, not defaults.
- Pick one clear aesthetic direction (e.g. editorial, minimal-graphite, brutalist, soft-glass) and apply it consistently. Avoid the generic "purple gradient + centered hero + 3 cards" template.
- Typography carries the design: 1–2 families, a real scale (e.g. 14/16/20/28/40/56), tight letter-spacing on large headings, line-height 1.5–1.7 for body, max ~70ch line length.
- Color: define tokens (bg, surface, border, text, muted, accent) as CSS variables; one accent color, used sparingly; check contrast ≥ 4.5:1; provide dark mode via prefers-color-scheme when reasonable.
- Spacing on a 4/8px grid; generous whitespace; align to a grid; consistent radii (pick one: 6, 10 or 14px).
- Hierarchy: one primary action per view; secondary actions visually quieter.
- Real content over lorem ipsum; realistic copy, numbers and states (empty, loading, error, hover, focus-visible, disabled).
- Mobile-first, responsive with fluid widths, no horizontal scroll; touch targets ≥ 40px.
- Subtle motion only (150–250ms ease-out), respect prefers-reduced-motion.
- Semantic HTML, alt text, labels, keyboard navigation.
- Deliver complete, runnable code (single file if not told otherwise), no placeholders like "add more here".`
  },
  {
    id: 'frontend-code',
    title: 'Frontend engineering',
    hint: 'React, Vue, Svelte, JS/TS in the browser, components, state, bundlers',
    keywords: ['react', 'vue', 'svelte', 'next.js', 'nextjs', 'компонент', 'component', 'frontend', 'фронтенд', 'typescript', 'javascript', 'jsx', 'tsx', 'vite', 'webpack', 'redux', 'hook'],
    text: `- Follow the framework's current idioms (function components + hooks, composition API, etc.). Match the user's stack; don't switch libraries silently.
- Keep components small and typed; derive state instead of duplicating it; lift state only as far as needed.
- Handle loading / error / empty states explicitly; never leave unhandled promises.
- Accessibility: semantic elements, labels, focus management, aria only where native semantics are missing.
- Avoid unnecessary dependencies; prefer platform APIs.
- Give complete files with imports; mention the exact install/run commands if new packages are needed.`
  },
  {
    id: 'backend-code',
    title: 'Backend & APIs',
    hint: 'servers, REST/GraphQL APIs, databases, auth, Python/Node/Go/Java services',
    keywords: ['api', 'backend', 'бэкенд', 'бэкэнд', 'сервер', 'server', 'endpoint', 'fastapi', 'django', 'flask', 'express', 'nestjs', 'golang', 'spring', 'microservice', 'rest', 'graphql', 'auth', 'jwt'],
    text: `- Validate all external input at the boundary; return consistent error shapes with correct HTTP status codes.
- Never hardcode secrets; read config from env; don't log tokens or passwords.
- Parameterized queries only; think about transactions, idempotency and race conditions.
- Timeouts and retries (with backoff) on outbound calls; close resources.
- Structure: thin handlers, logic in services, data access isolated.
- Show how to run it and one example request (curl). Mention migrations if schema changes.`
  },
  {
    id: 'debugging',
    title: 'Debugging & errors',
    hint: 'error messages, stack traces, something does not work, fixing bugs',
    keywords: ['ошибк', 'error', 'exception', 'traceback', 'не работает', 'баг', 'bug', 'падает', 'crash', 'fix', 'исправ', 'почему', 'undefined', 'null pointer', 'segfault', 'stack trace'],
    text: `- First identify the root cause from the evidence (error text, stack trace, versions); state it in one sentence before proposing a fix.
- Don't guess wildly: if information is missing, name the 1–2 most likely causes and how to confirm each.
- Give the minimal fix, show exactly what to change (diff or full corrected snippet), and explain why it works.
- Mention how to verify the fix and how to prevent regression (test, check, guard).
- Never "fix" by suppressing the error, disabling checks or catching-and-ignoring.`
  },
  {
    id: 'code-general',
    title: 'General coding quality',
    hint: 'writing code, scripts, algorithms, refactoring, any programming language',
    keywords: ['код', 'code', 'скрипт', 'script', 'функци', 'function', 'python', 'питон', 'алгоритм', 'algorithm', 'класс', 'class', 'refactor', 'рефактор', 'c++', 'rust', 'java', 'c#', 'kotlin', 'swift', 'php', 'bash', 'gdscript', 'godot', 'unity'],
    text: `- Before writing, settle the approach in one line; pick the simplest design that fully solves the task.
- Produce complete, runnable code — no ellipses, TODOs or "rest stays the same" unless editing a huge file (then show precise context).
- Handle edge cases: empty input, invalid types, large inputs, concurrency, encoding.
- Clear names, small functions, comments only where intent isn't obvious. Match the user's existing style and versions.
- After code: a brief note on how to run it and any assumptions. Don't pad with generic advice.`
  },
  {
    id: 'data-sql',
    title: 'Data, SQL & analytics',
    hint: 'SQL queries, pandas, data analysis, statistics, spreadsheets, charts',
    keywords: ['sql', 'запрос к базе', 'postgres', 'mysql', 'sqlite', 'pandas', 'dataframe', 'excel', 'таблиц', 'аналитик', 'статистик', 'statistics', 'dataset', 'датасет', 'график', 'chart', 'plot', 'numpy'],
    text: `- State assumptions about schema/columns explicitly if not given; use the user's names when given.
- SQL: explicit column lists, correct JOIN types, watch for NULL semantics, duplicates from joins, and index-friendly predicates. Mention dialect differences if relevant.
- Analysis: check data quality first (missing values, outliers, types), then compute; report numbers with units and context, not just code.
- Charts: choose the chart for the question (trend → line, comparison → bar, distribution → histogram); label axes; avoid pie charts with many slices.
- Distinguish correlation from causation; give uncertainty where it matters.`
  },
  {
    id: 'devops',
    title: 'DevOps & infrastructure',
    hint: 'Docker, Linux servers, nginx, CI/CD, deployment, Kubernetes, shell',
    keywords: ['docker', 'nginx', 'linux', 'ubuntu', 'deploy', 'деплой', 'ci/cd', 'github actions', 'kubernetes', 'k8s', 'systemd', 'ssh', 'сервак', 'vps', 'certbot', 'ssl', 'терминал', 'terminal'],
    text: `- Give copy-pasteable commands in order, with the target OS/distro assumed stated once.
- Prefer idempotent, reversible steps; back up configs before editing; warn before destructive commands (rm -rf, DROP, force push).
- Least privilege: non-root services, firewall only needed ports, secrets in env files with tight permissions.
- Include how to verify each step (status, logs, curl) and how to roll back.
- Pin versions in Dockerfiles/CI; use health checks and restart policies.`
  },
  {
    id: 'security',
    title: 'Security',
    hint: 'vulnerabilities, auth, encryption, secure coding, pentesting in authorized context',
    keywords: ['безопасн', 'security', 'уязвим', 'vulnerab', 'xss', 'csrf', 'sql injection', 'инъекц', 'шифрован', 'encrypt', 'hash', 'пароль', 'password', 'oauth', 'cors'],
    text: `- Default to secure choices: parameterized queries, output encoding, CSRF protection, strict CORS, modern password hashing (argon2id/bcrypt), TLS.
- Use vetted libraries for crypto; never invent schemes.
- Point out risks in the user's approach directly and give the safer alternative.
- Keep offensive details to what an authorized, defensive or educational context needs.`
  },
  {
    id: 'math-logic',
    title: 'Math & reasoning',
    hint: 'math problems, calculations, proofs, physics, logic puzzles',
    keywords: ['реши', 'задач', 'уравнен', 'equation', 'интеграл', 'integral', 'производн', 'derivative', 'математ', 'math', 'вероятност', 'probability', 'докаж', 'prove', 'физик', 'physics', 'вычисли', 'calculate', 'сколько будет'],
    text: `- Restate what is asked and the given data; define variables.
- Work step by step, checking each transformation; keep units through the calculation.
- Verify the result (substitute back, sanity-check magnitude, limiting cases).
- End with a clearly marked final answer. If the problem is ambiguous, say which interpretation you used.`
  },
  {
    id: 'writing',
    title: 'Writing & editing',
    hint: 'articles, posts, emails, essays, copywriting, editing and proofreading text',
    keywords: ['напиши текст', 'статью', 'статья', 'пост', 'письмо', 'email', 'эссе', 'essay', 'копирайт', 'copywriting', 'отредактируй', 'edit', 'перепиши', 'rewrite', 'резюме', 'resume', 'описание', 'description', 'сопроводительн'],
    text: `- Identify audience, goal and tone first; match the language and register of the user.
- Strong opening that delivers the point; one idea per paragraph; concrete details over abstractions.
- Cut filler, clichés and hedging ("в современном мире", "it's important to note"). Prefer active voice, short sentences mixed with longer ones.
- Use structure (headings, lists) only when it helps scanning.
- When editing, preserve the author's voice and meaning; fix what is wrong, don't rewrite everything.`
  },
  {
    id: 'creative',
    title: 'Creative writing',
    hint: 'stories, poems, scripts, game lore, characters, worldbuilding',
    keywords: ['рассказ', 'story', 'стих', 'poem', 'сценарий', 'script for video', 'персонаж', 'character', 'лор', 'lore', 'сюжет', 'plot', 'фэнтези', 'fantasy', 'сказк'],
    text: `- Show, don't tell: specific sensory details, actions and dialogue instead of stated emotions.
- Avoid predictable openings and endings, stock phrases and moralizing conclusions.
- Give characters wants and conflict; vary rhythm; keep a consistent point of view and tense.
- For poems: deliberate meter/rhyme or deliberate free verse — never accidental half-rhyme.
- Respect requested length and form precisely.`
  },
  {
    id: 'explain',
    title: 'Explaining & teaching',
    hint: 'explain a concept, how something works, learning, comparisons',
    keywords: ['объясни', 'explain', 'что такое', 'what is', 'как работает', 'how does', 'расскажи', 'в чем разница', 'difference between', 'сравни', 'compare', 'для чайников', 'простыми словами'],
    text: `- Lead with a direct one-or-two-sentence answer, then go deeper.
- Build from what the reader likely knows; one good analogy beats three weak ones.
- Use a small concrete example; for comparisons use a compact table.
- Be accurate over impressive: mark uncertainty, don't invent facts, citations or numbers.
- Match depth to the question; stop when the question is answered.`
  },
  {
    id: 'translation',
    title: 'Translation',
    hint: 'translate text between languages, localization',
    keywords: ['переведи', 'перевод', 'translate', 'translation', 'на английский', 'на русский', 'in english', 'локализ', 'localiz'],
    text: `- Translate meaning and tone, not word by word; keep idioms natural in the target language.
- Preserve formatting, markup, placeholders ({name}, %s) and code untouched.
- Keep terminology consistent; leave proper names and brand names as is unless a standard form exists.
- Output only the translation unless the user asked for notes.`
  },
  {
    id: 'business',
    title: 'Business, product & strategy',
    hint: 'business plans, marketing, product decisions, startups, pricing, strategy',
    keywords: ['бизнес', 'business', 'маркетинг', 'marketing', 'стартап', 'startup', 'продукт', 'product', 'стратеги', 'strategy', 'монетизац', 'pricing', 'цен', 'клиент', 'customer', 'конкурент', 'competitor', 'бизнес-план'],
    text: `- Start from the goal and constraints (budget, timeline, market); ask for or state assumptions.
- Be concrete: numbers, examples, prioritized actions with rough effort and impact.
- Name the main risks and the cheapest way to test the key assumption first.
- Avoid generic frameworks dumped without application to the user's case.`
  },
  {
    id: 'gamedev',
    title: 'Game development',
    hint: 'game engines (Godot, Unity, Unreal), game mechanics, shaders, game design',
    keywords: ['godot', 'gdscript', 'unity', 'unreal', 'игр', 'game', 'шейдер', 'shader', 'спрайт', 'sprite', 'геймдизайн', 'level', 'уровень', 'physics body', 'node2d', 'node3d'],
    text: `- Use the engine version's current API (e.g. Godot 4: @export, signal.connect(callable), CharacterBody2D + move_and_slide() without args). Say which version you target.
- Show where the script attaches (node type / scene tree) and any required input map or project settings.
- Frame-rate independence: multiply by delta; physics in _physics_process / FixedUpdate.
- Prefer signals/events over polling; keep scripts small and data-driven (resources, exported vars).
- For game design: tie mechanics to the core loop and player feedback.`
  },
  {
    id: 'prompting',
    title: 'Prompt engineering',
    hint: 'writing prompts or system prompts for LLMs, AI agents',
    keywords: ['промпт', 'prompt', 'системный промпт', 'system prompt', 'llm', 'gpt', 'нейросет', 'агент', 'agent'],
    text: `- Clarify role, task, context, constraints and output format; put examples where format matters.
- Be explicit and positive ("do X") rather than vague; give the why behind non-obvious rules.
- Separate instructions from data with clear delimiters; keep it as short as it can be while unambiguous.
- Suggest how to test the prompt on a few edge-case inputs.`
  }
];

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
