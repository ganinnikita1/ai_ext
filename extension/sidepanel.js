/**
 * sidepanel.js — логика боковой панели «AI Bro».
 *
 * Здесь: состояние чата, вызовы модели (или демо-режим), рендер сообщений,
 * варианты ответа на письмо, вставка в композер, обучение стилю и голосовой ввод
 * через Web Speech API. Никакого innerHTML для текста модели — только DOM API.
 */

import {
  STORAGE_KEYS,
  LIMITS,
  VOICE_LANGS,
  PROVIDER_PRESETS,
  normalizeSettings,
  isDemoMode,
  uid,
} from './lib/config.js';
import {
  streamTask,
  hasOriginPermission,
  requestOriginPermission,
  describeLLMError,
} from './lib/llm-client.js';
import {
  buildChatTask,
  buildReplyTask,
  buildSummaryTask,
  VariantStreamParser,
} from './lib/prompts.js';
import { normalizeProfile, buildStyleHints, learnFromPair } from './lib/style-profile.js';
import { demoStream } from './lib/demo.js';

// Fallback-окно (Chrome 114–115): в URL передан tabId целевой вкладки.
const popupTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = {
  chat: $('chat'),
  form: $('composer-form'),
  input: $('input'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  mic: $('btn-mic'),
  voiceStatus: $('voice-status'),
  providerState: $('provider-state'),
  banner: $('mode-banner'),
  bannerText: $('mode-banner-text'),
  bannerAction: $('btn-banner-action'),
  manualSection: $('manual-section'),
  manualText: $('manual-text'),
  manualPaste: $('btn-manual-paste'),
  manualClear: $('btn-manual-clear'),
  manualCounter: $('manual-counter'),
  btnNew: $('btn-new'),
  btnHistory: $('btn-history'),
  btnTheme: $('btn-theme'),
  btnSettings: $('btn-settings'),
  btnReply: $('btn-reply'),
  btnBrief: $('btn-brief'),
  btnSummary: $('btn-summary'),
  drawer: $('drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  drawerClose: $('btn-drawer-close'),
  sessionList: $('session-list'),
  toast: $('toast'),
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  settings: normalizeSettings(null),
  profile: normalizeProfile(null),
  sessions: [],
  activeId: null,
  tab: null,
  busy: false,
  controller: null,
  demo: true,
  manualText: '',
  theme: 'auto',
  voice: {
    recognition: null,
    active: false,
    baseText: '',
    finalText: '',
    silenceTimer: null,
    sessionTimer: null,
    restarts: 0,
  },
  lastAction: null,
};

const liveViews = new Map();
let saveTimer = null;
const MANUAL_LIMIT = 12000;

/* ------------------------------------------------------------------ */
/* small utils                                                         */
/* ------------------------------------------------------------------ */

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('toast--error', isError);
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('is-visible'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.classList.remove('is-visible');
    setTimeout(() => {
      el.toast.hidden = true;
    }, 200);
  }, 2600);
}

function humanTime(ts) {
  try {
    return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function scrollToBottom(force = false) {
  const threshold = 160;
  const nearBottom = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < threshold;
  if (force || nearBottom) el.chat.scrollTop = el.chat.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function normalizeSessions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((s) => s && typeof s === 'object' && typeof s.id === 'string')
    .map((s) => ({
      id: s.id,
      title: String(s.title || 'Чат').slice(0, 120),
      ts: Number(s.ts) || Date.now(),
      messages: Array.isArray(s.messages)
        ? s.messages
            .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => {
              const meta = m.meta && typeof m.meta === 'object' ? { ...m.meta } : {};
              delete meta.streaming;
              return {
                id: String(m.id || uid('msg')),
                role: m.role,
                content: m.content,
                ts: Number(m.ts) || Date.now(),
                meta,
              };
            })
        : [],
    }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, LIMITS.maxSessions);
}

async function loadState() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.profile, STORAGE_KEYS.chat]);
  state.settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  state.theme = state.settings.theme;
  state.profile = normalizeProfile(stored[STORAGE_KEYS.profile]);
  state.sessions = normalizeSessions(stored[STORAGE_KEYS.chat]);
  state.activeId = state.sessions.length ? state.sessions[0].id : null;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessions, 350);
}

async function saveSessions() {
  try {
    const persisted = state.sessions
      .filter((s) => s.messages.length)
      .slice(0, LIMITS.maxSessions)
      .map((s) => ({ ...s, messages: s.messages.slice(-80) }));
    await chrome.storage.local.set({ [STORAGE_KEYS.chat]: persisted });
  } catch (error) {
    console.warn('[AI Bro] saveSessions:', error);
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: state.settings });
  } catch (error) {
    console.warn('[AI Bro] saveSettings:', error);
  }
}

async function saveProfile() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.profile]: state.profile });
  } catch (error) {
    console.warn('[AI Bro] saveProfile:', error);
  }
}

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return darkQuery.matches ? 'dark' : 'light';
}

function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  const use = el.btnTheme.querySelector('use');
  if (use) use.setAttribute('href', resolved === 'dark' ? '#i-moon' : '#i-sun');
  el.btnTheme.title = `Тема: ${state.theme === 'auto' ? 'как в системе' : state.theme === 'dark' ? 'тёмная' : 'светлая'}`;
}

darkQuery.addEventListener('change', () => {
  if (state.theme === 'auto') applyTheme();
});

/* ------------------------------------------------------------------ */
/* provider state / banner                                             */
/* ------------------------------------------------------------------ */

async function refreshProviderState() {
  const settings = state.settings;
  state.demo = isDemoMode(settings);
  el.providerState.classList.remove('is-demo', 'is-live');
  if (state.demo) {
    el.providerState.textContent = 'Демо-режим · без ключа';
    el.providerState.classList.add('is-demo');
    el.banner.hidden = false;
    el.bannerText.textContent = 'API-ключ не задан — ответы демонстрационные.';
    el.bannerAction.textContent = 'Настроить';
    el.bannerAction.dataset.action = 'settings';
    return;
  }
  const preset = PROVIDER_PRESETS[settings.provider] || PROVIDER_PRESETS.deepseek;
  const granted = await hasOriginPermission(settings);
  el.providerState.textContent = `${preset.label} · ${settings.model.replace(/^deepseek-/, '')}`;
  el.providerState.classList.add(granted ? 'is-live' : 'is-demo');
  if (!granted) {
    el.banner.hidden = false;
    el.bannerText.textContent = 'Нет доступа к api.deepseek.com — запросы будут блокироваться.';
    el.bannerAction.textContent = 'Разрешить';
    el.bannerAction.dataset.action = 'permission';
  } else {
    el.banner.hidden = true;
  }
}

async function onBannerAction() {
  const action = el.bannerAction.dataset.action;
  if (action === 'settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (action === 'permission') {
    try {
      const granted = await requestOriginPermission(state.settings);
      if (granted) {
        toast('Доступ к api.deepseek.com разрешён');
        await refreshProviderState();
      } else {
        toast('Разрешение не выдано', true);
      }
    } catch (error) {
      toast(error && error.message ? error.message : 'Не удалось запросить разрешение', true);
    }
  }
}

/* ------------------------------------------------------------------ */
/* content script bridge                                              */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  if (popupTabId) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_TAB', tabId: popupTabId });
      if (res && res.ok && res.tab) {
        state.tab = res.tab;
        return res.tab;
      }
    } catch {
      /* упадём в обычный путь */
    }
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
    if (res && res.ok) {
      state.tab = res.tab;
      return res.tab;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function ensureContent(tabId) {
  const attempt = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT', tabId });
      return res || { ok: false, reason: 'NO_RESPONSE' };
    } catch {
      return { ok: false, reason: 'NO_RESPONSE' };
    }
  };
  let result = await attempt();
  // Гонка инъекции при первом открытии панели: до 2 повторов на NO_RESPONSE/INJECT_FAILED.
  for (let retry = 0; retry < 2 && !result.ok; retry += 1) {
    if (result.reason !== 'NO_RESPONSE' && result.reason !== 'INJECT_FAILED') break;
    await delay(280 + retry * 120);
    result = await attempt();
  }
  return result;
}

async function contentRequest(type, extra = {}) {
  const tab = await getActiveTab();
  if (!tab || !Number.isInteger(tab.id)) return { ok: false, reason: 'NO_TAB' };
  const ensure = await ensureContent(tab.id);
  if (!ensure.ok) return { ok: false, reason: ensure.reason || 'INJECT_FAILED', tab };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { target: 'content', type, ...extra });
    return res || { ok: false, reason: 'NO_RESPONSE', tab };
  } catch {
    return { ok: false, reason: 'NO_RESPONSE', tab };
  }
}

/* ------------------------------------------------------------------ */
/* manual message (единственный источник контекста)                    */
/* ------------------------------------------------------------------ */

function manualRaw() {
  return String(state.manualText || '');
}

function getManualText(options = {}) {
  const raw = manualRaw().trim();
  if (!raw) return '';
  if (raw.length > MANUAL_LIMIT) {
    if (options.notify) toast(`Текст обрезан до ${MANUAL_LIMIT.toLocaleString('ru-RU')} знаков.`, true);
    return raw.slice(0, MANUAL_LIMIT);
  }
  return raw;
}

/** Псевдо-mail: единственный источник — вставленный пользователем текст. */
function manualMail() {
  const text = getManualText({ notify: true });
  if (!text) return null;
  const message = { from: '', to: '', time: '', text, attachments: [] };
  return {
    site: 'manual',
    manual: true,
    subject: 'Своё сообщение',
    degraded: false,
    openIndex: 0,
    openMessage: message,
    threadMessages: [message],
    messages: [message],
    participants: [],
  };
}

function updateManualUi() {
  const raw = manualRaw();
  const length = raw.trim().length;
  el.manualCounter.textContent = `${length.toLocaleString('ru-RU')} / ${MANUAL_LIMIT.toLocaleString('ru-RU')} знаков`;
  el.manualCounter.classList.toggle('is-over', length > MANUAL_LIMIT);
  if (el.manualText.value !== raw) el.manualText.value = raw;
}

function setManualText(value, { notify = false } = {}) {
  let next = String(value || '');
  if (next.length > MANUAL_LIMIT) {
    next = next.slice(0, MANUAL_LIMIT);
    if (notify) toast(`Текст обрезан до ${MANUAL_LIMIT.toLocaleString('ru-RU')} знаков.`, true);
  }
  state.manualText = next;
  updateManualUi();
}

function clearManualText(message = 'Текст очищен') {
  state.manualText = '';
  updateManualUi();
  toast(message);
}

function openManualField() {
  el.manualText.focus();
}

function openMessageOf(mail) {
  if (!mail || typeof mail !== 'object') return null;
  const all = Array.isArray(mail.threadMessages)
    ? mail.threadMessages
    : Array.isArray(mail.messages)
      ? mail.messages
      : [];
  return (
    mail.openMessage ||
    (Number.isInteger(mail.openIndex) ? all[mail.openIndex] : null) ||
    all[all.length - 1] ||
    null
  );
}

function openOnlyMail(mail) {
  const open = openMessageOf(mail);
  if (!open) return mail;
  return { ...mail, messages: [open], threadMessages: [open], openMessage: open, openIndex: 0 };
}

function updateQuickActions() {
  // Действия всегда видны; без текста клик даёт подсказку и фокус на поле.
  el.btnReply.disabled = state.busy;
  el.btnBrief.disabled = state.busy;
  el.btnSummary.disabled = state.busy;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* sessions / chat rendering                                          */
/* ------------------------------------------------------------------ */

function findSession(id) {
  return state.sessions.find((s) => s.id === id) || null;
}

function ensureSession() {
  let session = findSession(state.activeId);
  if (session) return session;
  session = { id: uid('chat'), title: 'Новый чат', ts: Date.now(), messages: [] };
  state.sessions.unshift(session);
  state.activeId = session.id;
  return session;
}

function addMessage(message) {
  const session = ensureSession();
  session.messages.push(message);
  if (message.role === 'user' && session.title === 'Новый чат') {
    session.title = truncate(message.content, 60) || 'Новый чат';
  }
  session.ts = Date.now();
  scheduleSave();
  return message;
}

function renderEmptyState() {
  el.chat.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty';

  const icon = document.createElement('div');
  icon.className = 'empty__icon';
  icon.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-sparkles"></use></svg>';
  wrap.appendChild(icon);

  const title = document.createElement('h2');
  title.className = 'empty__title';
  title.textContent = 'Здесь появится ответ';
  wrap.appendChild(title);

  const text = document.createElement('p');
  text.className = 'empty__text';
  text.textContent =
    'Вставьте текст письма или сообщения в поле выше и выберите действие. AI Bro работает только с этим текстом и не читает страницы.';
  wrap.appendChild(text);

  const examples = document.createElement('p');
  examples.className = 'empty__examples';
  examples.textContent = 'Например: «Ответь коротко и по делу» или «Что от меня хотят?»';
  wrap.appendChild(examples);

  el.chat.appendChild(wrap);
}
function renderChat() {
  el.chat.textContent = '';
  liveViews.clear();
  const session = findSession(state.activeId);
  const messages = session ? session.messages : [];
  if (!messages.length) {
    renderEmptyState();
    return;
  }
  for (const message of messages) {
    const view = new MessageView(message);
    liveViews.set(message.id, view);
    el.chat.appendChild(view.root);
  }
  scrollToBottom(true);
}

/* ------------------------------------------------------------------ */
/* safe rich text (no innerHTML for model output)                      */
/* ------------------------------------------------------------------ */

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+/gi;

function appendInline(container, raw) {
  const text = String(raw || '');
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) appendTextWithLinks(container, text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      appendTextWithLinks(strong, token.slice(2, -2));
      container.appendChild(strong);
    } else {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
    }
    lastIndex = match.index + token.length;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) appendTextWithLinks(container, text.slice(lastIndex));
}

function appendTextWithLinks(container, raw) {
  const text = String(raw || '');
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let match = URL_RE.exec(text);
  while (match) {
    if (match.index > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    const url = match[0];
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = url;
    container.appendChild(anchor);
    lastIndex = match.index + url.length;
    match = URL_RE.exec(text);
  }
  if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
}

function appendParagraph(container, text) {
  const paragraph = document.createElement('p');
  appendInline(paragraph, text);
  container.appendChild(paragraph);
}

function renderRichText(container, raw) {
  container.textContent = '';
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  let codeLines = null;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    appendParagraph(container, paragraphLines.join('\n'));
    paragraphLines = [];
  };
  const closeList = () => {
    if (list) {
      container.appendChild(list);
      list = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (codeLines === null) {
        flushParagraph();
        closeList();
        codeLines = [];
      } else {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeLines.join('\n');
        pre.appendChild(code);
        container.appendChild(pre);
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^\s*#{2,4}\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const h = document.createElement('h4');
      appendInline(h, heading[1]);
      container.appendChild(h);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list || list.tagName !== 'UL') {
        closeList();
        list = document.createElement('ul');
      }
      const li = document.createElement('li');
      appendInline(li, bullet[1]);
      list.appendChild(li);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      if (!list || list.tagName !== 'OL') {
        closeList();
        list = document.createElement('ol');
      }
      const li = document.createElement('li');
      appendInline(li, numbered[1]);
      list.appendChild(li);
      continue;
    }
    closeList();
    paragraphLines.push(line);
  }
  if (codeLines !== null) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    container.appendChild(pre);
  }
  flushParagraph();
  closeList();
}

/* ------------------------------------------------------------------ */
/* MessageView                                                         */
/* ------------------------------------------------------------------ */

class MessageView {
  constructor(message) {
    this.message = message;
    this.root = document.createElement('article');
    this.root.className = `msg msg--${message.role}`;
    this.root.dataset.id = message.id;

    const head = document.createElement('div');
    head.className = 'msg__head';
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const name = document.createElement('span');
    name.textContent = message.role === 'user' ? 'Вы' : 'AI Bro';
    head.append(dot, name);
    if (message.role === 'assistant' && message.meta && message.meta.demo) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--warning';
      badge.textContent = 'демо';
      head.appendChild(badge);
    }
    this.root.appendChild(head);

    this.bubble = document.createElement('div');
    this.bubble.className = 'bubble';
    this.body = document.createElement('div');
    this.body.className = 'msg__body';
    this.bubble.appendChild(this.body);
    this.root.appendChild(this.bubble);

    this.actions = document.createElement('div');
    this.actions.className = 'msg__actions';
    this.root.appendChild(this.actions);

    this.typing = null;
    this.textNode = null;
    this.variantsEl = null;
    this.variantMap = new Map();
    this.finished = false;

    this.renderStatic();
    if (message.meta && message.meta.streaming) this.startStreaming();
  }

  renderStatic() {
    const meta = this.message.meta || {};
    if (this.message.role === 'assistant' && meta.error) {
      this.showError(meta.error, this.message);
      return;
    }
    if (this.message.role === 'assistant' && Array.isArray(meta.variants) && meta.variants.length) {
      this.renderVariants(meta.variants);
    } else {
      renderRichText(this.body, this.message.content || '');
    }
    this.renderActions();
    this.showDemoNotice();
  }

  showDemoNotice() {
    const text = this.message.meta && this.message.meta.demoNotice;
    if (!text || this.root.querySelector('.notice--demo')) return;
    const notice = document.createElement('p');
    notice.className = 'notice notice--demo';
    notice.textContent = text;
    this.root.appendChild(notice);
  }

  renderActions() {
    if (this.message.role !== 'assistant') return;
    this.actions.textContent = '';
    const meta = this.message.meta || {};
    // Варианты имеют собственные «Копировать/Вставить»; не дублируем ряд под сообщением.
    if (Array.isArray(meta.variants) && meta.variants.length) return;
    if (!this.message.content) return;
    this.actions.appendChild(this.makeMiniButton('Копировать', '#i-copy', () => this.copyAll()));
    // Вставка в письмо — только у ответа (черновика), не у сводки и не у чата.
    if (meta.kind === 'reply') {
      this.actions.appendChild(this.makeMiniButton('Вставить в письмо', '#i-insert', () => this.insertAll()));
    }
  }

  makeMiniButton(label, icon, onClick, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mini-btn ${extraClass}`.trim();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', icon);
    svg.appendChild(use);
    button.appendChild(svg);
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await onClick(button);
      } catch (error) {
        toast(error && error.message ? error.message : 'Ошибка действия', true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  async copyAll() {
    const text = this.collectText();
    if (!text.trim()) return;
    await copyToClipboard(text);
    toast('Скопировано');
  }

  async insertAll() {
    const text = this.collectText();
    if (!text.trim()) return;
    const inserted = await insertTextIntoPage(text);
    if (inserted) this.offerLearning(text);
  }

  collectText() {
    const meta = this.message.meta || {};
    if (Array.isArray(meta.variants) && meta.variants.length) {
      // Никогда не склеиваем все варианты в одно письмо: только первый/выбранный.
      return meta.variants[0].text || '';
    }
    return this.message.content || '';
  }

  offerLearning(draft) {
    if (this.actions.querySelector('[data-learn]')) return;
    const button = this.makeMiniButton('Учиться на правке', '#i-save', async () => {
      await rememberEdit(draft);
      button.remove();
    });
    button.dataset.learn = '1';
    this.actions.appendChild(button);
  }

  /* --------------------------- streaming -------------------------- */

  startStreaming() {
    this.body.textContent = '';
    this.typing = document.createElement('span');
    this.typing.className = 'typing';
    this.typing.innerHTML = '<span></span><span></span><span></span>';
    this.body.appendChild(this.typing);
    this.textNode = null;
    this.cursor = document.createElement('span');
    this.cursor.className = 'cursor';
    this.cursor.hidden = true;
    this.body.appendChild(this.cursor);
  }

  appendText(chunk) {
    if (this.finished) return;
    if (!chunk) return;
    if (this.typing) {
      this.typing.remove();
      this.typing = null;
    }
    if (!this.textNode) {
      this.textNode = document.createTextNode('');
      this.body.insertBefore(this.textNode, this.cursor || null);
    }
    this.textNode.nodeValue += chunk;
    if (this.cursor) this.cursor.hidden = false;
    scrollToBottom();
  }

  startVariants() {
    if (this.typing) {
      this.typing.remove();
      this.typing = null;
    }
    if (this.variantsEl) return this.variantsEl;
    this.body.textContent = '';
    this.variantsEl = document.createElement('div');
    this.variantsEl.className = 'variants';
    this.bubble.appendChild(this.variantsEl);
    return this.variantsEl;
  }

  ensureVariantCard(number, tone) {
    this.startVariants();
    if (this.variantMap.has(number)) return this.variantMap.get(number);
    const card = document.createElement('div');
    card.className = 'variant';
    const head = document.createElement('div');
    head.className = 'variant__head';
    const index = document.createElement('span');
    index.className = 'variant__index';
    index.textContent = String(number);
    const toneEl = document.createElement('span');
    toneEl.className = 'variant__tone';
    toneEl.textContent = tone || 'вариант';
    head.append(index, toneEl);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'variant__body';
    const actionsEl = document.createElement('div');
    actionsEl.className = 'variant__actions';
    card.append(head, bodyEl, actionsEl);
    this.variantsEl.appendChild(card);
    const record = { number, tone, card, bodyEl, actionsEl, text: '' };
    this.variantMap.set(number, record);
    return record;
  }

  pushVariantEvent(event) {
    if (!event || !event.delta) return;
    if (event.variant === 0) {
      // Текст до первого маркера — показываем как обычный ответ.
      this.appendText(event.delta);
      return;
    }
    const record = this.ensureVariantCard(event.variant, event.tone);
    record.text += event.delta;
    record.bodyEl.textContent = record.text;
    if (this.cursor) this.cursor.hidden = true;
    scrollToBottom();
  }

  renderVariants(variants) {
    this.body.textContent = '';
    if (this.variantsEl) this.variantsEl.remove();
    this.variantsEl = document.createElement('div');
    this.variantsEl.className = 'variants';
    this.bubble.appendChild(this.variantsEl);
    this.variantMap.clear();
    variants.forEach((variant, index) => {
      const number = index + 1;
      const record = this.ensureVariantCard(number, variant.tone);
      record.text = variant.text;
      record.bodyEl.textContent = variant.text;
      this.renderVariantActions(record);
    });
  }

  renderVariantActions(record) {
    record.actionsEl.textContent = '';
    const copy = this.makeMiniButton('Копировать', '#i-copy', async () => {
      await copyToClipboard(record.text);
      toast('Вариант скопирован');
    });
    const insert = this.makeMiniButton(
      'Вставить в письмо',
      '#i-insert',
      async () => {
        const ok = await insertTextIntoPage(record.text);
        if (ok) {
          const learn = this.makeMiniButton('Учиться на правке', '#i-save', async () => {
            await rememberEdit(record.text);
            learn.remove();
          });
          learn.dataset.learn = '1';
          record.actionsEl.appendChild(learn);
        }
      },
      'mini-btn--primary',
    );
    record.actionsEl.append(copy, insert);
  }

  finishStreaming(message) {
    if (this.finished) return;
    this.finished = true;
    const meta = message.meta || {};
    if (this.typing) {
      this.typing.remove();
      this.typing = null;
    }
    if (this.cursor) {
      this.cursor.remove();
      this.cursor = null;
    }
    if (meta.error) {
      this.showError(meta.error, message);
      if (!message.content) this.bubble.hidden = true;
      return;
    }
    if (Array.isArray(meta.variants) && meta.variants.length) {
      this.renderVariants(meta.variants);
    } else {
      renderRichText(this.body, message.content || '');
      if (!message.content.trim()) {
        this.body.textContent = meta.stopped ? 'Остановлено.' : 'Пустой ответ.';
      }
    }
    if (meta.stopped) {
      const notice = document.createElement('p');
      notice.className = 'notice';
      notice.textContent = 'Ответ остановлен.';
      this.root.appendChild(notice);
    }
    this.renderActions();
  }

  showError(info, message) {
    this.bubble.hidden = true;
    this.actions.textContent = '';
    const box = document.createElement('div');
    box.className = 'error-box';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-alert');
    svg.appendChild(use);
    const content = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'error-box__title';
    title.textContent = info.title || 'Ошибка';
    content.appendChild(title);
    if (info.hint) {
      const hint = document.createElement('p');
      hint.className = 'error-box__hint';
      hint.textContent = info.hint;
      content.appendChild(hint);
    }
    const actionRow = document.createElement('div');
    actionRow.className = 'error-box__actions';

    const action = message && message.meta && message.meta.action;
    if (action) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost-btn';
      retry.textContent = 'Повторить';
      retry.addEventListener('click', () => {
        removeMessage(message);
        runAction(action);
      });
      actionRow.appendChild(retry);
    }
    if (info.code === 'NO_PERMISSION') {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'ghost-btn';
      grant.textContent = 'Разрешить домен';
      grant.addEventListener('click', async () => {
        try {
          const granted = await requestOriginPermission(state.settings);
          if (granted) {
            toast('Разрешение получено');
            await refreshProviderState();
            removeMessage(message);
            if (action) runAction(action);
          }
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось запросить разрешение', true);
        }
      });
      actionRow.appendChild(grant);
    }
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'ghost-btn';
    settings.textContent = 'Настройки';
    settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
    actionRow.appendChild(settings);

    content.appendChild(actionRow);
    box.append(svg, content);
    this.root.appendChild(box);
  }
}

function removeMessage(message) {
  const session = findSession(state.activeId);
  if (!session) return;
  const index = session.messages.findIndex((m) => m.id === message.id);
  if (index >= 0) session.messages.splice(index, 1);
  const view = liveViews.get(message.id);
  if (view) {
    view.root.remove();
    liveViews.delete(message.id);
  }
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* clipboard / insertion / learning                                    */
/* ------------------------------------------------------------------ */

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function insertTextIntoPage(text) {
  // Никакого чтения страницы/письма: только вставка в композер.
  const res = await contentRequest('INSERT_TEXT', { text });
  if (res.ok) {
    toast('Вставлено в письмо. Проверьте текст перед отправкой.');
    return true;
  }
  if (res.reason === 'COMPOSER_IN_IFRAME') {
    await copyToClipboard(text);
    toast('Композер внутри iframe — текст скопирован, вставьте вручную (Ctrl+V).', true);
    return false;
  }
  if (res.reason === 'COMPOSER_NOT_FOUND') {
    await copyToClipboard(text);
    toast('Композер не найден. Текст скопирован — вставьте вручную (Ctrl+V).', true);
    return false;
  }
  await copyToClipboard(text);
  toast('Автовставка не удалась. Текст скопирован — вставьте вручную.', true);
  return false;
}

async function rememberEdit(draft) {
  const res = await contentRequest('GET_COMPOSER');
  if (!res.ok) {
    toast('Не удалось прочитать текст письма для обучения', true);
    return;
  }
  const result = learnFromPair(state.profile, { draft, finalText: res.text, kind: 'reply' });
  if (!result.learned) {
    toast(result.reason, true);
    return;
  }
  state.profile = result.profile;
  await saveProfile();
  toast(`Стиль обновлён: ${result.reason}`);
}

/* ------------------------------------------------------------------ */
/* task execution                                                      */
/* ------------------------------------------------------------------ */

function setBusy(busy) {
  state.busy = busy;
  el.stop.hidden = !busy;
  document.body.classList.toggle('is-busy', busy);
  el.chat.setAttribute('aria-busy', busy ? 'true' : 'false');
  updateQuickActions();
  updateSendState();
}

function updateSendState() {
  el.send.disabled = state.busy || !String(el.input.value || '').trim();
}

function historyForPrompt() {
  const session = findSession(state.activeId);
  if (!session) return [];
  return session.messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .slice(-LIMITS.historyMessages)
    .map((m) => ({ role: m.role, content: m.content }));
}

function styleHints() {
  return buildStyleHints(state.profile);
}

async function executeTask(task, options = {}) {
  if (state.busy) return null;
  const session = ensureSession();
  const message = {
    id: uid('msg'),
    role: 'assistant',
    content: '',
    ts: Date.now(),
    meta: { streaming: true, demo: state.demo, kind: options.kind || task.kind, action: options.action || state.lastAction },
  };
  session.messages.push(message);
  session.ts = Date.now();
  const view = new MessageView(message);
  liveViews.set(message.id, view);
  el.chat.appendChild(view.root);
  const empty = el.chat.querySelector('.empty');
  if (empty) empty.remove();
  scrollToBottom(true);
  scheduleSave();

  setBusy(true);
  const controller = new AbortController();
  state.controller = controller;
  const parser = options.variantMode ? new VariantStreamParser() : null;
  let gotVariantEvents = false;

  try {
    const handle = (event) => {
      if (event.type === 'notice') {
        toast(event.text);
        return;
      }
      if (event.type !== 'token') return;
      message.content += event.text;
      if (parser) {
        for (const variantEvent of parser.push(event.text)) {
          gotVariantEvents = true;
          view.pushVariantEvent(variantEvent);
        }
      } else {
        view.appendText(event.text);
      }
    };
    if (state.demo) {
      for await (const event of demoStream({ task, signal: controller.signal })) handle(event);
    } else {
      for await (const event of streamTask({ settings: state.settings, task, signal: controller.signal })) handle(event);
    }
    if (parser) {
      let variants = parser.finish();
      if (!variants.length || (variants.length === 1 && !gotVariantEvents)) {
        variants = [{ index: 1, number: 1, tone: '', text: message.content.trim() }];
      }
      if (variants.length === 1) {
        // Модель не дала маркеров — показываем один ответ без служебных заголовков.
        message.content = variants[0].text;
      } else {
        message.meta.variants = variants.map((v) => ({ tone: v.tone || '', text: v.text }));
      }
    }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORTED')) {
      message.meta.stopped = true;
    } else {
      const info = describeLLMError(error);
      message.meta.error = info;
    }
  } finally {
    delete message.meta.streaming;
    state.controller = null;
    view.finishStreaming(message);
    if (state.demo && !message.meta.error) {
      message.meta.demoNotice = 'Демо-ответ без обращения к модели. Ключ настраивается в разделе «Настройки».';
      view.showDemoNotice();
    }
    setBusy(false);
    scheduleSave();
    scrollToBottom();
  }
  return message;
}

async function sendChat(question) {
  const text = String(question || '').trim();
  if (!text) return;

  const action = { name: 'chat', question: text };
  state.lastAction = action;
  const history = historyForPrompt().slice(0, -1);

  // Контекст — только вставленный текст. Страницы и почту не читаем.
  const manual = manualMail();
  const context = manual ? { kind: 'mail', mail: manual } : null;

  const userMessage = { id: uid('msg'), role: 'user', content: text, ts: Date.now(), meta: {} };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);
  el.input.value = '';
  resizeInput();
  updateSendState();
  el.input.focus();

  const task = buildChatTask({
    question: text,
    context,
    styleHints: styleHints(),
    history,
    scope: 'open',
  });
  await executeTask(task, { kind: 'chat', action });
}

function chatFocus() {
  el.input.focus();
}

async function generateReply(intent = '') {
  if (state.busy) return;
  const manual = manualMail();
  if (!manual) {
    toast('Сначала вставьте текст письма или сообщения в поле выше.', true);
    openManualField();
    return;
  }
  const baseMail = manual;
  const userMessage = {
    id: uid('msg'),
    role: 'user',
    content: intent ? `Ответь на вставленный текст. ${intent}` : 'Предложи ответ на вставленный текст',
    ts: Date.now(),
    meta: {},
  };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);

  const action = { name: 'reply', intent };
  state.lastAction = action;
  const settings = state.settings;
  const mail = openOnlyMail(baseMail);
  const task = buildReplyTask({
    mail,
    styleHints: styleHints(),
    variants: 3,
    intent,
    instruction: settings.replyInstruction,
  });
  await executeTask(task, { kind: 'reply', variantMode: true, action });
}

async function generateSummary(brief = false) {
  if (state.busy) return;
  const manual = manualMail();
  if (!manual) {
    toast('Сначала вставьте текст письма или сообщения в поле выше.', true);
    openManualField();
    return;
  }
  const baseMail = manual;
  const briefMode = Boolean(brief);
  const userMessage = {
    id: uid('msg'),
    role: 'user',
    content: briefMode ? 'Краткая сводка вставленного текста' : 'Разбери вставленный текст',
    ts: Date.now(),
    meta: {},
  };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);

  const action = { name: 'summary', brief: briefMode };
  state.lastAction = action;
  const task = buildSummaryTask({ mail: openOnlyMail(baseMail), styleHints: styleHints(), scope: 'open', brief: briefMode });
  await executeTask(task, { kind: briefMode ? 'brief' : 'summary', action });
}

function runAction(action) {
  if (!action) return;
  if (action.name === 'chat') return sendChat(action.question);
  if (action.name === 'reply') return generateReply(action.intent || '');
  if (action.name === 'summary') return generateSummary(Boolean(action.brief));
  return undefined;
}

function stopStreaming() {
  if (state.controller) {
    try {
      state.controller.abort();
    } catch {
      /* ignore */
    }
    toast('Остановлено');
  }
}

/* ------------------------------------------------------------------ */
/* history drawer                                                      */
/* ------------------------------------------------------------------ */

function renderSessions() {
  el.sessionList.textContent = '';
  const sessions = state.sessions.filter((s) => s.messages.length);
  if (!sessions.length) {
    const empty = document.createElement('li');
    empty.className = 'session-empty';
    empty.textContent = 'Пока нет сохранённых чатов.';
    el.sessionList.appendChild(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement('li');
    item.className = `session-item${session.id === state.activeId ? ' is-active' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'session-open';
    const title = document.createElement('span');
    title.className = 'session-open__title';
    title.textContent = session.title || 'Чат';
    const meta = document.createElement('span');
    meta.className = 'session-open__meta';
    meta.textContent = `${session.messages.length} сообщ. · ${humanTime(session.ts)}`;
    open.append(title, meta);
    open.addEventListener('click', () => {
      state.activeId = session.id;
      renderChat();
      renderSessions();
      closeDrawer();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn icon-btn--sm session-delete';
    remove.title = 'Удалить чат';
    remove.setAttribute('aria-label', 'Удалить чат');
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      state.sessions = state.sessions.filter((s) => s.id !== session.id);
      if (state.activeId === session.id) state.activeId = state.sessions[0] ? state.sessions[0].id : null;
      await saveSessions();
      renderChat();
      renderSessions();
      toast('Чат удалён');
    });
    item.append(open, remove);
    el.sessionList.appendChild(item);
  }
}

function openDrawer() {
  renderSessions();
  el.drawer.hidden = false;
  el.drawerBackdrop.hidden = false;
  el.btnHistory.setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  el.drawer.hidden = true;
  el.drawerBackdrop.hidden = true;
  el.btnHistory.setAttribute('aria-expanded', 'false');
}

function newChat() {
  const existing = findSession(state.activeId);
  if (existing && !existing.messages.length) {
    closeDrawer();
    chatFocus();
    return;
  }
  const session = { id: uid('chat'), title: 'Новый чат', ts: Date.now(), messages: [] };
  state.sessions.unshift(session);
  state.activeId = session.id;
  renderChat();
  renderSessions();
  closeDrawer();
  chatFocus();
}

/* ------------------------------------------------------------------ */
/* voice input (Web Speech API)                                       */
/* ------------------------------------------------------------------ */

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

const VOICE_ERRORS = {
  'not-allowed': 'Доступ к микрофону запрещён. Разрешите микрофон для расширения в настройках сайта.',
  'service-not-allowed': 'Браузер запретил сервис распознавания речи.',
  'audio-capture': 'Микрофон не найден. Подключите устройство и повторите.',
  network: 'Сервис распознавания недоступен: нужен интернет (в Chromium речь обрабатывает облако Google/Microsoft).',
  'language-not-supported': 'Язык распознавания не поддерживается. Выберите другой в настройках.',
  'bad-grammar': 'Ошибка распознавания. Попробуйте ещё раз.',
};

function refreshVoiceUi() {
  const supported = !!SpeechRecognitionCtor;
  const enabled = state.settings.voice.enabled;
  el.mic.classList.toggle('is-unavailable', !supported || !enabled);
  el.mic.title = !supported
    ? 'Голосовой ввод не поддерживается этим браузером'
    : !enabled
      ? 'Голосовой ввод выключен в настройках'
      : 'Голосовой ввод (Web Speech API)';
  el.mic.disabled = !supported || !enabled;
}

function setVoiceStatus(text, isError = false) {
  el.voiceStatus.textContent = text;
  el.voiceStatus.classList.toggle('is-error', isError);
}

function clearVoiceTimers() {
  clearTimeout(state.voice.silenceTimer);
  clearTimeout(state.voice.sessionTimer);
  state.voice.silenceTimer = null;
  state.voice.sessionTimer = null;
}

function resetVoiceSilenceTimer() {
  clearTimeout(state.voice.silenceTimer);
  state.voice.silenceTimer = setTimeout(() => {
    stopVoice();
  }, 2600);
}

function voiceLangLabel() {
  const lang = state.settings.voice.lang;
  const found = VOICE_LANGS.find((l) => l.id === lang);
  return found ? found.label : lang;
}

function stopVoice() {
  const voice = state.voice;
  clearVoiceTimers();
  if (voice.recognition) {
    try {
      voice.recognition.stop();
    } catch {
      /* ignore */
    }
  }
  voice.active = false;
  el.mic.classList.remove('is-recording');
  el.mic.setAttribute('aria-pressed', 'false');
  if (!state.busy) setVoiceStatus('');
  const finalText = voice.finalText.trim();
  if (finalText) {
    const full = voice.baseText ? `${voice.baseText} ${finalText}` : finalText;
    el.input.value = full;
    resizeInput();
    updateSendState();
  }
  if (state.settings.voice.autoSend && finalText) {
    const text = el.input.value.trim();
    if (text) sendChat(text);
  }
  voice.finalText = '';
}

function startVoice() {
  const voice = state.voice;
  if (voice.active) {
    stopVoice();
    return;
  }
  if (!state.settings.voice.enabled) {
    toast('Голосовой ввод выключен в настройках', true);
    return;
  }
  if (!SpeechRecognitionCtor) {
    toast('Браузер не поддерживает Web Speech API. Попробуйте Chrome/Edge или настройте внешний STT.', true);
    return;
  }
  if (!window.isSecureContext) {
    toast('Голосовой ввод требует защищённый контекст', true);
    return;
  }
  let recognition;
  try {
    recognition = new SpeechRecognitionCtor();
  } catch {
    toast('Не удалось запустить распознавание речи', true);
    return;
  }
  voice.recognition = recognition;
  voice.active = true;
  voice.finalText = '';
  voice.baseText = el.input.value.trim() ? el.input.value.trim() : '';
  voice.restarts = 0;
  el.mic.classList.add('is-recording');
  el.mic.setAttribute('aria-pressed', 'true');
  setVoiceStatus(`Слушаю… ${voiceLangLabel()}`);

  recognition.lang = state.settings.voice.lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0] ? result[0].transcript : '';
      if (result.isFinal) finalText += transcript;
      else interimText += transcript;
    }
    voice.finalText = finalText;
    const composed = [voice.baseText, `${finalText}${interimText}`.trim()].filter(Boolean).join(' ');
    el.input.value = composed;
    resizeInput();
    updateSendState();
    setVoiceStatus(`Слушаю… ${voiceLangLabel()}`);
    resetVoiceSilenceTimer();
  };

  recognition.onerror = (event) => {
    if (event.error === 'aborted') return;
    const message = VOICE_ERRORS[event.error] || `Ошибка распознавания: ${event.error}`;
    setVoiceStatus(message, true);
    toast(message, true);
    voice.active = false;
    clearVoiceTimers();
    el.mic.classList.remove('is-recording');
    el.mic.setAttribute('aria-pressed', 'false');
  };

  recognition.onend = () => {
    if (!voice.active) {
      el.mic.classList.remove('is-recording');
      el.mic.setAttribute('aria-pressed', 'false');
      return;
    }
    // Chrome может завершить сессию сам — перезапускаемся, пока пользователь не остановил.
    if (voice.restarts < 4) {
      voice.restarts += 1;
      try {
        recognition.start();
        return;
      } catch {
        /* ниже завершим */
      }
    }
    stopVoice();
  };

  try {
    recognition.start();
    resetVoiceSilenceTimer();
    state.voice.sessionTimer = setTimeout(() => {
      if (voice.active) {
        toast('Голосовой ввод остановлен через 60 секунд');
        stopVoice();
      }
    }, 60000);
  } catch (error) {
    voice.active = false;
    el.mic.classList.remove('is-recording');
    el.mic.setAttribute('aria-pressed', 'false');
    toast(error && error.message ? error.message : 'Не удалось запустить микрофон', true);
  }
}

/* ------------------------------------------------------------------ */
/* input handling                                                      */
/* ------------------------------------------------------------------ */

function resizeInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 132)}px`;
}

async function onSubmit(event) {
  event.preventDefault();
  if (state.voice.active) stopVoice();
  const text = el.input.value.trim();
  if (!text) return;
  if (state.busy) {
    toast('Дождитесь окончания текущего ответа');
    return;
  }
  await sendChat(text);
}

/* ------------------------------------------------------------------ */
/* events / init                                                       */
/* ------------------------------------------------------------------ */

function bindEvents() {
  el.form.addEventListener('submit', onSubmit);
  el.input.addEventListener('input', () => {
    resizeInput();
    updateSendState();
  });
  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      el.form.requestSubmit();
    }
    if (event.key === 'Escape' && state.busy) {
      event.preventDefault();
      stopStreaming();
    }
  });
  el.stop.addEventListener('click', stopStreaming);
  el.mic.addEventListener('click', startVoice);
  el.btnReply.addEventListener('click', () => generateReply());
  el.btnBrief.addEventListener('click', () => generateSummary(true));
  el.btnSummary.addEventListener('click', () => generateSummary(false));
  el.manualText.addEventListener('input', () => {
    state.manualText = el.manualText.value;
    updateManualUi();
  });
  el.manualPaste.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') throw new Error('NO_CLIPBOARD');
      const text = await navigator.clipboard.readText();
      if (!String(text || '').trim()) {
        toast('Буфер обмена пуст — вставьте текст вручную (Ctrl+V).', true);
        el.manualText.focus();
        return;
      }
      setManualText(text, { notify: true });
      el.manualText.focus();
      toast('Вставлено из буфера');
    } catch {
      el.manualText.focus();
      toast('Буфер недоступен — вставьте вручную (Ctrl+V).', true);
    }
  });
  el.manualClear.addEventListener('click', () => {
    clearManualText();
    el.manualText.focus();
  });
  el.btnNew.addEventListener('click', newChat);
  el.btnHistory.addEventListener('click', () => (el.drawer.hidden ? openDrawer() : closeDrawer()));
  el.drawerClose.addEventListener('click', closeDrawer);
  el.drawerBackdrop.addEventListener('click', closeDrawer);
  el.btnTheme.addEventListener('click', async () => {
    const order = ['auto', 'light', 'dark'];
    const index = order.indexOf(state.theme);
    state.theme = order[(index + 1) % order.length];
    state.settings = { ...state.settings, theme: state.theme };
    applyTheme();
    await saveSettings();
  });
  el.btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.bannerAction.addEventListener('click', onBannerAction);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.voice.active) stopVoice();
      if (!el.drawer.hidden) closeDrawer();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      state.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      state.theme = state.settings.theme;
      applyTheme();
      refreshVoiceUi();
      refreshProviderState();
    }
    if (changes[STORAGE_KEYS.profile]) {
      state.profile = normalizeProfile(changes[STORAGE_KEYS.profile].newValue);
    }
  });
}

async function init() {
  try {
    await loadState();
  } catch (error) {
    console.warn('[AI Bro] loadState:', error);
  }
  applyTheme();
  refreshVoiceUi();
  resizeInput();
  updateSendState();
  await refreshProviderState();
  bindEvents();
  updateManualUi();
  renderChat();
  updateQuickActions();
  el.manualText.focus();
}

init().catch((error) => {
  console.error('[AI Bro] init failed', error);
  renderChat();
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = `Не удалось запустить панель: ${error && error.message ? error.message : error}`;
  el.chat.appendChild(box);
});
