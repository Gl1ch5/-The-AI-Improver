// AI Improver admin UI — dependency-free, small on purpose.

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0));

// Relative URLs so the panel works both at the domain root and under a path prefix (e.g. /improver/).
const ROOT = new URL('.', location.href.split('#')[0]);
const S = { cat: 'all', q: '', state: null, view: location.hash.slice(1) || 'overview', chat: [], meta: null, logs: [] };

async function api(path, opts = {}) {
  const res = await fetch(new URL('api' + path, ROOT), {
    method: opts.method || 'GET',
    headers: opts.method && opts.method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    renderLogin();
    throw new Error('login');
  }
  if (!res.ok) throw new Error(json.error?.message || 'Ошибка ' + res.status);
  return json;
}

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

const run = fn => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    if (e.message !== 'login') toast(e.message, true);
  }
};

async function refresh() {
  S.state = await api('/state');
}

// ---------- icons ----------
const I = {
  overview: '<path d="M3 13h4v8H3zM10 3h4v18h-4zM17 9h4v12h-4z"/>',
  models: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/>',
  classifier: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>',
  providers: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="10" cy="18" r="1.5"/>',
  library: '<path d="M4 4h6v16H4zM14 4l6 1-2 15-6-1z"/>',
  playground: '<path d="M4 5h16v11H8l-4 4z"/>',
  logs: '<path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/>'
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

const NAV = [
  ['overview', 'Обзор'],
  ['models', 'Модели'],
  ['classifier', 'Классификатор'],
  ['providers', 'Провайдеры'],
  ['library', 'Библиотека'],
  ['playground', 'Песочница'],
  ['logs', 'Журнал']
];

// ---------- shell ----------
function renderLogin() {
  $('#root').innerHTML = `
    <div class="overlay" style="background:var(--bg)">
      <form class="modal login" id="loginForm">
        <div class="brand"><div class="dot"></div><div>AI Improver<small>панель управления</small></div></div>
        <label class="f"><span>Пароль администратора</span><input type="password" name="password" autofocus autocomplete="current-password"></label>
        <div class="actions"><button class="btn primary" style="width:100%">Войти</button></div>
        <p class="faint small" style="margin:14px 0 0">Пароль задаётся переменной ADMIN_PASSWORD или лежит в data/admin-password.txt на сервере.</p>
      </form>
    </div>`;
  $('#loginForm').onsubmit = run(async e => {
    e.preventDefault();
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    await refresh();
    render();
  });
}

function render() {
  const v = S.view;
  $('#root').innerHTML = `
    <div class="app">
      <aside class="side">
        <div class="brand"><div class="dot"></div><div>AI Improver<small>тихое улучшение ответов</small></div></div>
        <nav class="nav">${NAV.map(([k, t]) => `<a href="#${k}" class="${k === v ? 'active' : ''}">${icon(k)}${t}</a>`).join('')}</nav>
        <div class="foot"><a href="#" data-a="logout" class="faint">Выйти</a></div>
      </aside>
      <main id="main">${(VIEWS[v] || VIEWS.overview)()}</main>
    </div>`;
  AFTER[v]?.();
}

window.addEventListener('hashchange', () => {
  S.view = location.hash.slice(1) || 'overview';
  run(async () => {
    await refresh();
    if (S.view === 'logs') S.logs = (await api('/logs')).logs;
    render();
  })();
});

// ---------- views ----------
const head = (title, sub, actions = '') => `<div class="head"><div><h1>${title}</h1><p>${sub}</p></div><div class="row">${actions}</div></div>`;
const sw = (name, on, label = '') => `<label class="switch"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><i></i>${label}</label>`;
const provName = id => S.state.providers.find(p => p.id === id)?.name || '—';
const modeLabel = { off: 'выкл', pre: 'подсказки', tool: 'советник', both: 'подсказки + советник' };

const CAT_LABEL = { all: 'Все', behavior: 'Поведение', writing: 'Тексты', design: 'Дизайн', coding: 'Код', reasoning: 'Рассуждения', domains: 'Сферы', custom: 'Свои' };

function guideRows() {
  const q = S.q.trim().toLowerCase();
  const list = S.state.guides.filter(g => (S.cat === 'all' || (g.category || 'custom') === S.cat) && (!q || [g.id, g.title, g.hint, ...(g.keywords || [])].join(' ').toLowerCase().includes(q)));
  return list.map(g => `
        <div class="item">
          <label class="switch" data-guide-toggle="${g.id}"><input type="checkbox" ${g.enabled ? 'checked' : ''}><i></i></label>
          <div class="grow"><div class="title">${esc(g.title)} <span class="faint mono small">${esc(g.id)}</span>${g.edited ? ' <span class="pill">изменена</span>' : ''}</div><div class="sub">${esc(g.hint)}</div></div>
          <span class="pill">${esc(CAT_LABEL[g.category] || g.category || 'свои')}</span>
          <span class="pill">≈${Math.ceil(g.text.length / 3.6)} ток.</span>
          <button class="btn sm" data-a="editGuide" data-id="${g.id}">Изменить</button>
        </div>`).join('') || '<div class="empty">Ничего не найдено</div>';
}

const VIEWS = {
  overview() {
    const s = S.state.stats;
    const base = new URL('v1', ROOT).href;
    const enhancedPct = s.requests ? Math.round((s.enhanced / s.requests) * 100) : 0;
    const hits = Object.entries(s.guideHits || {}).sort((a, b) => b[1] - a[1]);
    const maxHit = hits[0]?.[1] || 1;
    const key = S.state.apiKeys[0]?.key || 'sk-...';
    return `
      ${head('Обзор', 'OpenAI-совместимый прокси: классифицирует запрос маленькой моделью и незаметно подмешивает инструкции.')}
      <div class="grid g4">
        <div class="card stat"><div class="v">${fmt(s.requests)}</div><div class="k">запросов</div></div>
        <div class="card stat"><div class="v">${enhancedPct}%</div><div class="k">улучшено</div></div>
        <div class="card stat"><div class="v">${s.avgClassifierMs || 0}<span class="muted small"> мс</span></div><div class="k">средняя задержка классификатора</div></div>
        <div class="card stat"><div class="v">${fmt(s.classifierPromptTokens + s.classifierCompletionTokens)}</div><div class="k">токенов классификатора · ${fmt(s.cacheHits)} из кэша</div></div>
      </div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card">
          <div class="card-head"><h2>Подключение</h2>${sw('requireApiKey', S.state.requireApiKey, '<span class="small muted">требовать ключ</span>')}</div>
          <div class="stack">
            <label class="f"><span>Base URL</span><div class="codebox"><code>${esc(base)}</code><button class="btn sm ghost" data-copy="${esc(base)}">Копировать</button></div></label>
            <div>
              <div class="row spread" style="margin-bottom:6px"><span class="muted small">API-ключи</span><button class="btn sm" data-a="addKey">Новый ключ</button></div>
              <div class="list">${S.state.apiKeys.map(k => `
                <div class="item"><div class="grow"><div class="title">${esc(k.name)}</div><div class="sub mono">${esc(k.key)}</div></div>
                <button class="btn sm ghost" data-copy="${esc(k.key)}">Копировать</button><button class="btn sm ghost danger" data-a="delKey" data-id="${k.id}">Удалить</button></div>`).join('') || '<div class="empty">Ключей нет</div>'}</div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Пример</h2><span class="pill">stream: true поддерживается</span></div>
          <div class="inspect"><pre>${esc(`curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${S.state.models[0]?.name || 'improved-gpt'}","stream":true,
       "messages":[{"role":"user","content":"Сделай лендинг для кофейни"}]}'`)}</pre></div>
          <p class="muted small" style="margin:12px 0 0">Работает с любым клиентом OpenAI SDK: укажите Base URL и ключ выше, а в поле model — имя виртуальной модели.</p>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Вход без пароля</h2>${sw('rememberIp', S.state.rememberIp, '<span class="small muted">запоминать IP после входа</span>')}</div>
        <p class="muted small" style="margin:-6px 0 10px">С этих адресов панель открывается сразу. Ваш текущий IP: <span class="mono">${esc(S.state.myIp)}</span>. «Выйти» убирает текущий адрес из списка.</p>
        <div class="list">${S.state.trustedIps.map(t => `
          <div class="item"><div class="grow"><div class="title mono">${esc(t.ip)}${t.ip === S.state.myIp ? ' <span class="pill ok">это вы</span>' : ''}</div><div class="sub">${new Date(t.added).toLocaleString()} · ${esc(t.agent || '')}</div></div>
          <button class="btn sm ghost danger" data-a="delTrusted" data-ip="${esc(t.ip)}">Убрать</button></div>`).join('') || '<div class="empty">Пока пусто — адрес добавится при следующем входе</div>'}</div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Какие инструкции срабатывают</h2><span class="muted small">≈ ${fmt(s.injectedTokensEst)} токенов подмешано всего</span></div>
        ${hits.length ? `<table><tbody>${hits.map(([id, n]) => `<tr><td style="width:200px">${esc(S.state.guides.find(g => g.id === id)?.title || id)}</td><td><div class="bar"><b style="width:${(n / maxHit) * 100}%"></b></div></td><td class="num" style="width:60px">${n}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Пока нет данных — отправьте запрос в песочнице</div>'}
      </div>`;
  },

  models() {
    const ms = S.state.models;
    return `
      ${head('Модели', 'Виртуальные модели, которые видят клиенты. У каждой — своё имя, целевая модель, системный промпт и режим улучшения.', '<button class="btn primary" data-a="editModel">Добавить модель</button>')}
      <div class="card"><div class="list">${ms.map(m => `
        <div class="item">
          <div class="grow"><div class="title">${esc(m.name)} ${m.enabled ? '' : '<span class="pill">выключена</span>'}</div>
          <div class="sub">${esc(provName(m.providerId))} · <span class="mono">${esc(m.upstreamModel || '—')}</span> · ${modeLabel[m.enhance?.mode || 'off']}${m.systemPrompt ? ' · свой промпт' : ''}</div></div>
          <button class="btn sm" data-a="editModel" data-id="${m.id}">Изменить</button>
        </div>`).join('') || '<div class="empty">Моделей нет</div>'}</div></div>
      <div class="card"><h3>Режимы</h3><div class="grid g3" style="margin-top:12px">
        <div><b>Подсказки</b><p class="muted small">До отправки классификатор выбирает инструкции и пишет короткую критику; это незаметно добавляется в системный контекст. Минимум задержки.</p></div>
        <div><b>Советник</b><p class="muted small">Для сложных задач модель получает скрытый инструмент. Перед ответом она отправляет туда план, быстрая модель критикует его, и ответ продолжается — клиент этого не видит.</p></div>
        <div><b>Подсказки + советник</b><p class="muted small">Оба механизма. Максимальное качество, немного больше токенов.</p></div>
      </div></div>`;
  },

  classifier() {
    const c = S.state.classifier;
    const a = S.state.advisor;
    const provOpts = (sel, allowEmpty) => (allowEmpty ? '<option value="">как у классификатора</option>' : '') + S.state.providers.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    return `
      ${head('Классификатор', 'Маленькая быстрая модель без размышлений: видит только последний запрос, выбирает инструкции и даёт критику.')}
      <form class="card stack" id="clsForm">
        <div class="card-head" style="margin:0"><h2>Модель-классификатор</h2>${sw('enabled', c.enabled, '<span class="small muted">LLM-классификация (иначе — локальные эвристики)</span>')}</div>
        <div class="grid g2">
          <label class="f"><span>Провайдер</span><select name="providerId">${provOpts(c.providerId)}</select></label>
          <label class="f"><span>Модель</span><input name="model" value="${esc(c.model)}" list="clsModels" placeholder="gpt-4.1-nano"><datalist id="clsModels"></datalist></label>
        </div>
        <div class="grid g4">
          <label class="f"><span>Макс. токенов ответа</span><input type="number" name="maxTokens" value="${c.maxTokens}"></label>
          <label class="f"><span>Таймаут, мс</span><input type="number" name="timeoutMs" value="${c.timeoutMs}"></label>
          <label class="f"><span>Символов запроса</span><input type="number" name="maxInputChars" value="${c.maxInputChars}"></label>
          <label class="f"><span>Кэш, сек</span><input type="number" name="cacheTtlSec" value="${c.cacheTtlSec}"></label>
        </div>
        <div class="row">${sw('skipTrivial', c.skipTrivial, '<span class="small">Не тратить токены на приветствия и «спасибо»</span>')}</div>
        <label class="f"><span>Доп. параметры запроса (JSON) — например, отключение размышлений: {"reasoning_effort":"minimal"} или {"enable_thinking":false}</span><textarea name="extraBody" rows="2">${esc(JSON.stringify(c.extraBody || {}))}</textarea></label>
        <label class="f"><span>Системный промпт классификатора · {{CATALOG}} заменяется списком инструкций</span><textarea name="systemPrompt" rows="10">${esc(c.systemPrompt)}</textarea></label>
        <div class="row spread"><button type="button" class="btn ghost sm" data-a="resetPrompt" data-k="classifier">Вернуть промпт по умолчанию</button><button class="btn primary">Сохранить</button></div>
      </form>
      <form class="card stack" id="advForm">
        <div class="card-head" style="margin:0"><h2>Советник (режим «советник»)</h2></div>
        <div class="grid g4">
          <label class="f"><span>Провайдер</span><select name="providerId">${provOpts(a.providerId, true)}</select></label>
          <label class="f"><span>Модель</span><input name="model" value="${esc(a.model)}" placeholder="как у классификатора"></label>
          <label class="f"><span>Макс. токенов</span><input type="number" name="maxTokens" value="${a.maxTokens}"></label>
          <label class="f"><span>Таймаут, мс</span><input type="number" name="timeoutMs" value="${a.timeoutMs}"></label>
        </div>
        <label class="f"><span>Системный промпт советника</span><textarea name="systemPrompt" rows="4">${esc(a.systemPrompt)}</textarea></label>
        <div class="row spread"><button type="button" class="btn ghost sm" data-a="resetPrompt" data-k="advisor">Вернуть промпт по умолчанию</button><button class="btn primary">Сохранить</button></div>
      </form>
      <form class="card stack" id="testForm">
        <div class="card-head" style="margin:0"><h2>Проверка</h2><span class="muted small">покажет, что будет подмешано</span></div>
        <textarea name="text" rows="3" style="font-family:var(--sans);font-size:14px" placeholder="Например: сделай сайт-портфолио для фотографа"></textarea>
        <div class="row"><button class="btn">Классифицировать</button></div>
        <div id="testOut"></div>
      </form>`;
  },

  providers() {
    return `
      ${head('Провайдеры', 'Любые OpenAI-совместимые API: OpenAI, OpenRouter, DeepSeek, Groq, локальные Ollama / vLLM / LM Studio.', '<button class="btn primary" data-a="editProvider">Добавить</button>')}
      <div class="card"><div class="list">${S.state.providers.map(p => `
        <div class="item">
          <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub mono">${esc(p.baseUrl)} · ${p.apiKeySet ? 'ключ ' + esc(p.apiKeyPreview) : 'без ключа'}</div></div>
          <button class="btn sm ghost" data-a="checkProvider" data-id="${p.id}">Проверить</button>
          <button class="btn sm" data-a="editProvider" data-id="${p.id}">Изменить</button>
        </div>`).join('') || '<div class="empty">Нет провайдеров</div>'}</div></div>`;
  },

  library() {
    const cats = ['all', ...new Set(S.state.guides.map(g => g.category || 'custom'))];
    const on = S.state.guides.filter(g => g.enabled).length;
    return `
      ${head('Библиотека', `Не скиллы, а короткие рабочие заметки. Классификатор выбирает до двух подходящих, и они тихо добавляются в контекст. Включено ${on} из ${S.state.guides.length}.`, '<button class="btn primary" data-a="editGuide">Новая инструкция</button>')}
      <div class="row spread" style="margin-bottom:14px">
        <div class="seg" id="catSeg">${cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === S.cat ? 'on' : ''}">${esc(CAT_LABEL[c] || c)}</button>`).join('')}</div>
        <input id="guideSearch" placeholder="Поиск по названию, id, описанию…" style="max-width:300px" value="${esc(S.q)}">
      </div>
      <div class="card"><div class="list" id="guideList">${guideRows()}</div></div>`;
  },

  playground() {
    const ms = S.state.models.filter(m => m.enabled);
    return `
      ${head('Песочница', 'Живой чат через прокси со стримингом. Справа — что увидела маленькая модель и что было подмешано.', `<select id="pgModel" style="width:220px">${ms.map(m => `<option>${esc(m.name)}</option>`).join('')}</select><button class="btn" data-a="clearChat">Очистить</button>`)}
      <div class="play">
        <div class="card chat">
          <div class="msgs" id="msgs">${S.chat.map(m => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('') || '<div class="empty">Напишите что-нибудь, например «сделай лендинг для барбершопа»</div>'}</div>
          <form class="composer" id="chatForm"><textarea name="q" rows="1" placeholder="Сообщение…"></textarea><button class="btn primary">Отправить</button></form>
        </div>
        <div class="card inspect stack"><h3>Вмешательство</h3><div id="meta">${metaHtml(S.meta)}</div></div>
      </div>`;
  },

  logs() {
    return `
      ${head('Журнал', 'Последние запросы через прокси.', '<button class="btn" data-a="reloadLogs">Обновить</button><button class="btn ghost danger" data-a="resetStats">Сбросить статистику</button>')}
      <div class="card" style="overflow:auto">${S.logs.length ? `<table>
        <thead><tr><th>Время</th><th>Модель</th><th>Запрос</th><th>Решение</th><th>Классиф.</th><th>Всего</th><th>Статус</th></tr></thead>
        <tbody>${S.logs.map(l => `<tr>
          <td class="num">${new Date(l.at).toLocaleTimeString()}</td>
          <td><div>${esc(l.model)}</div><div class="faint small mono">${esc(l.upstreamModel || '')}</div></td>
          <td style="max-width:320px"><div>${esc(l.preview)}</div>${l.critique ? `<div class="faint small">${esc(l.critique)}</div>` : ''}${l.advice ? `<div class="faint small">советник: ${esc(l.advice)}</div>` : ''}${l.error ? `<div class="small" style="color:var(--bad)">${esc(l.error)}</div>` : ''}</td>
          <td><div class="row" style="gap:4px">${(l.guides || []).map(g => `<span class="pill">${esc(g)}</span>`).join('') || `<span class="faint small">${esc(l.complexity || '')}</span>`}${l.tool ? '<span class="pill">советник</span>' : ''}</div></td>
          <td class="num">${esc(l.source || '')}<br>${l.classifierMs ?? 0} мс</td>
          <td class="num">${l.totalMs ?? '…'} мс</td>
          <td><span class="pill ${l.status === 200 ? 'ok' : l.status ? 'bad' : 'warn'}">${l.status || '…'}</span></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">Запросов ещё не было</div>'}</div>`;
  }
};

function metaHtml(m) {
  if (!m) return '<p class="faint small">Отправьте сообщение, чтобы увидеть классификацию.</p>';
  const c = m.classification || {};
  return `
    <div class="row" style="gap:6px">
      <span class="pill">${esc(c.complexity)}</span><span class="pill">${esc(c.source)}</span><span class="pill">${c.ms || 0} мс</span><span class="pill">+${m.injectedTokens || 0} ток.</span>
    </div>
    ${c.error ? `<p class="small" style="color:var(--bad)">${esc(c.error)}</p>` : ''}
    <div class="row" style="gap:6px;margin-top:10px">${(m.guides || []).map(g => `<span class="pill ok">${esc(g)}</span>`).join('') || '<span class="faint small">инструкции не выбраны</span>'}</div>
    ${c.critique ? `<p class="small" style="margin:12px 0 0"><span class="muted">Критика:</span> ${esc(c.critique)}</p>` : ''}
    <div style="margin-top:12px"><pre>${esc(m.injected || '— ничего не подмешано —')}</pre></div>`;
}

// ---------- per-view wiring ----------
const AFTER = {
  overview() {
    $('[name=rememberIp]').onchange = run(async e => {
      await api('/general', { method: 'PUT', body: { rememberIp: e.target.checked } });
      toast(e.target.checked ? 'IP будут запоминаться' : 'Вход только по паролю');
    });
    $('[name=requireApiKey]').onchange = run(async e => {
      await api('/general', { method: 'PUT', body: { requireApiKey: e.target.checked } });
      toast(e.target.checked ? 'Ключ обязателен' : 'Доступ без ключа');
    });
  },
  classifier() {
    const num = ['maxTokens', 'timeoutMs', 'maxInputChars', 'cacheTtlSec'];
    $('#clsForm').onsubmit = run(async e => {
      e.preventDefault();
      const f = e.target;
      const body = { enabled: f.enabled.checked, skipTrivial: f.skipTrivial.checked, providerId: f.providerId.value, model: f.model.value.trim(), systemPrompt: f.systemPrompt.value };
      for (const k of num) body[k] = Number(f[k].value);
      try {
        body.extraBody = JSON.parse(f.extraBody.value || '{}');
      } catch {
        throw new Error('Доп. параметры: невалидный JSON');
      }
      await api('/classifier', { method: 'PUT', body });
      await refresh();
      toast('Сохранено');
    });
    $('#advForm').onsubmit = run(async e => {
      e.preventDefault();
      const f = e.target;
      await api('/advisor', { method: 'PUT', body: { providerId: f.providerId.value, model: f.model.value.trim(), maxTokens: Number(f.maxTokens.value), timeoutMs: Number(f.timeoutMs.value), systemPrompt: f.systemPrompt.value } });
      await refresh();
      toast('Сохранено');
    });
    $('#testForm').onsubmit = run(async e => {
      e.preventDefault();
      $('#testOut').innerHTML = '<p class="faint small">…</p>';
      const r = await api('/classify', { method: 'POST', body: { text: e.target.text.value } });
      $('#testOut').innerHTML = `<div class="inspect">${metaHtml({ classification: r, guides: r.guides, injected: r.injected, injectedTokens: Math.ceil((r.injected || '').length / 3.6) })}</div>`;
    });
    const prov = $('[name=providerId]', $('#clsForm'));
    const loadList = () => api(`/providers/${prov.value}/models`).then(r => ($('#clsModels').innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join(''))).catch(() => {});
    prov.onchange = loadList;
    loadList();
  },
  library() {
    const bindToggles = () =>
      document.querySelectorAll('[data-guide-toggle]').forEach(el => {
        el.querySelector('input').onchange = run(async e => {
          await api('/guides/' + el.dataset.guideToggle, { method: 'PUT', body: { enabled: e.target.checked } });
          await refresh();
        });
      });
    const redraw = () => {
      $('#guideList').innerHTML = guideRows();
      bindToggles();
    };
    $('#guideSearch').oninput = e => {
      S.q = e.target.value;
      redraw();
    };
    document.querySelectorAll('#catSeg button').forEach(b => (b.onclick = () => {
      S.cat = b.dataset.cat;
      document.querySelectorAll('#catSeg button').forEach(x => x.classList.toggle('on', x === b));
      redraw();
    }));
    bindToggles();
  },
  playground() {
    const ta = $('#chatForm textarea');
    ta.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#chatForm').requestSubmit();
      }
    };
    $('#chatForm').onsubmit = run(async e => {
      e.preventDefault();
      const q = ta.value.trim();
      if (!q) return;
      ta.value = '';
      S.chat.push({ role: 'user', content: q });
      const model = $('#pgModel').value;
      render();
      $('#pgModel').value = model;
      await streamChat(model);
    });
    const m = $('#msgs');
    m.scrollTop = m.scrollHeight;
  }
};

async function streamChat(model) {
  const msgs = $('#msgs');
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  bubble.textContent = '…';
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;

  const res = await fetch(new URL('v1/chat/completions', ROOT), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-improver-debug': '1' },
    body: JSON.stringify({ model, stream: true, messages: S.chat.map(({ role, content }) => ({ role, content })) })
  });
  const metaHdr = res.headers.get('x-improver-meta');
  if (metaHdr) {
    S.meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(metaHdr.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    $('#meta').innerHTML = metaHtml(S.meta);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    bubble.textContent = 'Ошибка: ' + (j.error?.message || res.status);
    S.chat.pop();
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let think = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const delta = JSON.parse(d).choices?.[0]?.delta || {};
        text += delta.content || '';
        think += delta.reasoning_content || delta.reasoning || '';
      } catch {}
    }
    bubble.textContent = text || (think ? '💭 ' + think.slice(-400) : '…');
    msgs.scrollTop = msgs.scrollHeight;
  }
  S.chat.push({ role: 'assistant', content: text });
}

// ---------- modals ----------
function modal(html, onSubmit) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<form class="modal stack">${html}</form>`;
  document.body.appendChild(o);
  const onKey = e => e.key === 'Escape' && close();
  const close = () => {
    o.remove();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  o.addEventListener('mousedown', e => e.target === o && close());
  o.querySelector('[data-close]')?.addEventListener('click', close);
  const form = o.querySelector('form');
  const done = run(async action => {
    await onSubmit(form, action);
    close();
    await refresh();
    render();
  });
  form.onsubmit = e => {
    e.preventDefault();
    done('save');
  };
  // Secondary actions are type=button so Enter in a field can never trigger them.
  o.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => done(b.dataset.act)));
  o.querySelector('input,textarea')?.focus();
  return o;
}

function editModel(id) {
  const m = S.state.models.find(x => x.id === id) || { name: '', enabled: true, providerId: S.state.providers[0]?.id, upstreamModel: '', systemPrompt: '', extraBody: {}, enhance: { mode: 'pre', guides: true, critique: true, maxGuides: 2 } };
  const e = m.enhance;
  const o = modal(
    `<h2>${id ? 'Модель' : 'Новая модель'}</h2>
    <div class="grid g2">
      <label class="f"><span>Имя для клиентов (любое)</span><input name="name" value="${esc(m.name)}" required placeholder="my-smart-model"></label>
      <label class="f"><span>Провайдер</span><select name="providerId">${S.state.providers.map(p => `<option value="${p.id}" ${p.id === m.providerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    </div>
    <label class="f"><span>Целевая модель у провайдера</span><input name="upstreamModel" value="${esc(m.upstreamModel)}" list="upModels" required placeholder="gpt-4.1, deepseek-chat, …"><datalist id="upModels"></datalist></label>
    <label class="f"><span>Системный промпт (добавляется перед промптом клиента)</span><textarea name="systemPrompt" rows="5">${esc(m.systemPrompt)}</textarea></label>
    <div><span class="muted small">Режим улучшения</span><div class="seg" id="modeSeg" style="margin-top:6px">${Object.entries(modeLabel).map(([k, t]) => `<button type="button" data-mode="${k}" class="${k === e.mode ? 'on' : ''}">${t}</button>`).join('')}</div></div>
    <div class="row" style="gap:22px">${sw('guides', e.guides, 'инструкции из библиотеки')}${sw('critique', e.critique, 'критика классификатора')}${sw('enabled', m.enabled, 'включена')}
      <label class="row small muted" style="gap:8px">до <input type="number" name="maxGuides" value="${e.maxGuides ?? 2}" min="0" max="5" style="width:64px"> инструкций</label></div>
    <label class="f"><span>Доп. параметры запроса к модели (JSON, перезаписывают параметры клиента)</span><textarea name="extraBody" rows="2">${esc(JSON.stringify(m.extraBody || {}))}</textarea></label>
    <div class="actions" style="justify-content:space-between">
      <div>${id ? '<button type="button" class="btn ghost danger" data-act="delete">Удалить</button>' : ''}</div>
      <div class="row"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </div>`,
    async (f, action) => {
      if (action === 'delete') {
        if (!confirm('Удалить модель?')) throw new Error('Отменено');
        return api('/models/' + id, { method: 'DELETE' });
      }
      let extraBody;
      try {
        extraBody = JSON.parse(f.extraBody.value || '{}');
      } catch {
        throw new Error('Доп. параметры: невалидный JSON');
      }
      const body = {
        name: f.name.value.trim(),
        providerId: f.providerId.value,
        upstreamModel: f.upstreamModel.value.trim(),
        systemPrompt: f.systemPrompt.value,
        enabled: f.enabled.checked,
        extraBody,
        enhance: { mode: $('#modeSeg .on').dataset.mode, guides: f.guides.checked, critique: f.critique.checked, maxGuides: Number(f.maxGuides.value) }
      };
      await api('/models' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
      toast('Сохранено');
    }
  );
  o.querySelectorAll('#modeSeg button').forEach(b => (b.onclick = () => {
    o.querySelectorAll('#modeSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  }));
  const prov = o.querySelector('[name=providerId]');
  const load = () => api(`/providers/${prov.value}/models`).then(r => (o.querySelector('#upModels').innerHTML = r.models.map(x => `<option value="${esc(x)}">`).join(''))).catch(() => {});
  prov.onchange = load;
  load();
}

function editProvider(id) {
  const p = S.state.providers.find(x => x.id === id) || { name: '', baseUrl: 'https://', apiKeySet: false };
  modal(
    `<h2>${id ? 'Провайдер' : 'Новый провайдер'}</h2>
    <label class="f"><span>Название</span><input name="name" value="${esc(p.name)}" required placeholder="OpenRouter"></label>
    <label class="f"><span>Base URL (до /chat/completions)</span><input name="baseUrl" value="${esc(p.baseUrl)}" required placeholder="https://openrouter.ai/api/v1"></label>
    <label class="f"><span>API-ключ ${p.apiKeySet ? '· сохранён ' + esc(p.apiKeyPreview) + ', оставьте пустым чтобы не менять' : ''}</span><input type="password" name="apiKey" autocomplete="off" placeholder="sk-..."></label>
    <div class="actions" style="justify-content:space-between">
      <div>${id ? '<button type="button" class="btn ghost danger" data-act="delete">Удалить</button>' : ''}</div>
      <div class="row"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </div>`,
    async (f, action) => {
      if (action === 'delete') {
        if (!confirm('Удалить провайдера?')) throw new Error('Отменено');
        return api('/providers/' + id, { method: 'DELETE' });
      }
      await api('/providers' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: { name: f.name.value.trim(), baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim() } });
      toast('Сохранено');
    }
  );
}

function editGuide(id) {
  const g = S.state.guides.find(x => x.id === id) || { id: '', title: '', hint: '', keywords: [], text: '', enabled: true, builtin: false };
  modal(
    `<h2>${id ? esc(g.title) : 'Новая инструкция'}</h2>
    <div class="grid g2">
      <label class="f"><span>Название</span><input name="title" value="${esc(g.title)}" required></label>
      <label class="f"><span>ID ${id ? '' : '(латиница)'}</span><input name="id" value="${esc(g.id)}" ${id ? 'disabled' : ''} placeholder="my-guide"></label>
    </div>
    <label class="f"><span>Когда применять — подсказка для классификатора (одна строка)</span><input name="hint" value="${esc(g.hint)}" placeholder="landing pages, UI, CSS"></label>
    <label class="f"><span>Ключевые слова для запасной эвристики (через запятую)</span><input name="keywords" value="${esc((g.keywords || []).join(', '))}"></label>
    <label class="f"><span>Липкие фразы: если пользователь хоть раз их написал, инструкция действует до конца диалога (через запятую, можно пусто)</span><input name="stickyTriggers" value="${esc((g.stickyTriggers || []).join(', '))}" placeholder="как человек, без воды"></label>
    <label class="f"><span>Текст инструкции — пишите коротко и повелительно</span><textarea name="text" rows="14">${esc(g.text)}</textarea></label>
    <div class="actions" style="justify-content:space-between">
      <div class="row">${id && g.builtin ? '<button type="button" class="btn ghost" data-act="reset">Сбросить к исходной</button>' : ''}${id && !g.builtin ? '<button type="button" class="btn ghost danger" data-act="delete">Удалить</button>' : ''}</div>
      <div class="row"><button type="button" class="btn ghost" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </div>`,
    async (f, action) => {
      if (action === 'reset') return api(`/guides/${id}/reset`, { method: 'POST', body: {} });
      if (action === 'delete') {
        if (!confirm('Удалить инструкцию?')) throw new Error('Отменено');
        return api('/guides/' + id, { method: 'DELETE' });
      }
      const body = { title: f.title.value.trim(), hint: f.hint.value.trim(), keywords: f.keywords.value.split(',').map(s => s.trim()).filter(Boolean), stickyTriggers: f.stickyTriggers.value.split(',').map(s => s.trim()).filter(Boolean), text: f.text.value.trim() };
      if (!id) body.id = f.id.value.trim();
      await api('/guides' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
      toast('Сохранено');
    }
  );
}

// ---------- global actions ----------
const ACTIONS = {
  logout: run(async () => {
    await api('/logout', { method: 'POST', body: {} });
    renderLogin();
  }),
  addKey: run(async () => {
    const name = prompt('Название ключа', 'client');
    if (name === null) return;
    await api('/keys', { method: 'POST', body: { name } });
    await refresh();
    render();
  }),
  delKey: run(async el => {
    if (!confirm('Удалить ключ? Клиенты с ним перестанут работать.')) return;
    await api('/keys/' + el.dataset.id, { method: 'DELETE' });
    await refresh();
    render();
  }),
  delTrusted: run(async el => {
    await api('/trusted/' + encodeURIComponent(el.dataset.ip), { method: 'DELETE' });
    await refresh();
    render();
  }),
  editModel: el => editModel(el.dataset.id),
  editProvider: el => editProvider(el.dataset.id),
  editGuide: el => editGuide(el.dataset.id),
  checkProvider: run(async el => {
    const r = await api(`/providers/${el.dataset.id}/models`);
    toast(`Доступно моделей: ${r.models.length}`);
  }),
  resetPrompt: el => {
    const form = el.closest('form');
    form.systemPrompt.value = S.state.defaults[el.dataset.k];
    toast('Промпт вставлен — нажмите «Сохранить»');
  },
  clearChat: () => {
    S.chat = [];
    S.meta = null;
    render();
  },
  reloadLogs: run(async () => {
    S.logs = (await api('/logs')).logs;
    render();
  }),
  resetStats: run(async () => {
    if (!confirm('Сбросить статистику и журнал?')) return;
    await api('/stats', { method: 'DELETE' });
    S.logs = [];
    await refresh();
    render();
  })
};

document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) {
    e.preventDefault();
    navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Скопировано'), () => toast('Не удалось скопировать', true));
    return;
  }
  const a = e.target.closest('[data-a]');
  if (a && ACTIONS[a.dataset.a]) {
    e.preventDefault();
    ACTIONS[a.dataset.a](a);
  }
});

// ---------- boot ----------
(async () => {
  const me = await fetch(new URL('api/me', ROOT)).then(r => r.json());
  if (!me.admin) return renderLogin();
  await refresh();
  if (S.view === 'logs') S.logs = (await api('/logs')).logs;
  render();
})();
