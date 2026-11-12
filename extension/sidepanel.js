/**
 * sidepanel.js — логика боковой панели «Почерк».
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
  buildExplainTask,
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
  note: $('composer-note'),
  providerState: $('provider-state'),
  banner: $('mode-banner'),
  bannerText: $('mode-banner-text'),
  bannerAction: $('btn-banner-action'),
  contextBar: $('context-bar'),
  contextIcon: $('context-icon'),
  contextKind: $('context-kind'),
  contextTitle: $('context-title'),
  contextScope: $('context-scope'),
  messagePicker: $('message-picker'),
  messageSelect: $('message-select'),
  messageMeta: $('message-meta'),
  contextRemove: $('btn-context-remove'),
  contextRefresh: $('btn-context-refresh'),
  btnNew: $('btn-new'),
  btnHistory: $('btn-history'),
  btnTheme: $('btn-theme'),
  btnSettings: $('btn-settings'),
  btnExplain: $('btn-explain'),
  btnReply: $('btn-reply'),
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
  context: null,
  tab: null,
  busy: false,
  controller: null,
  demo: true,
  mailAvailable: false,
  accessError: null,
  mailSelectionKey: null,
  mailSelectionExplicit: false,
  theme: 'auto',
  voice: {
    recognition: null,
    active: false,
    supported: false,
    baseText: '',
    finalText: '',
    silenceTimer: null,
    sessionTimer: null,
    restarts: 0,
  },
  lastAction: null,
  pendingRequestPage: false,
};

const liveViews = new Map();
let saveTimer = null;
let contextRefreshTimer = null;

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
    console.warn('[Почерк] saveSessions:', error);
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: state.settings });
  } catch (error) {
    console.warn('[Почерк] saveSettings:', error);
  }
}

async function saveProfile() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.profile]: state.profile });
  } catch (error) {
    console.warn('[Почерк] saveProfile:', error);
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

function accessErrorText(reason) {
  switch (reason) {
    case 'RESTRICTED_URL':
      return 'На служебных страницах браузера (chrome://, edge://, about:) чтение контента недоступно.';
    case 'WEBSTORE':
      return 'Chrome Web Store и Edge Add-ons запрещают доступ к своим страницам.';
    case 'NO_HOST_ACCESS':
      return 'Нет доступа к этой вкладке. Разрешите сайт кнопкой ниже или откройте панель через иконку расширения на нужной вкладке.';
    case 'NO_RESPONSE':
      return 'Контент-скрипт не ответил. Обновите страницу (F5) и повторите.';
    case 'NO_TAB':
      return 'Активная вкладка не найдена.';
    default:
      return 'Не удалось прочитать активную вкладку.';
  }
}

function patternForUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

async function requestTabAccess() {
  const tab = await getActiveTab();
  const pattern = tab ? patternForUrl(tab.url) : null;
  if (!pattern) {
    toast('Для этой вкладки нельзя запросить доступ', true);
    return false;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (granted) {
      toast('Доступ к сайту разрешён');
      await initContext();
    }
    return granted;
  } catch (error) {
    toast(error && error.message ? error.message : 'Не удалось запросить доступ', true);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* context bar                                                         */
/* ------------------------------------------------------------------ */

function contextTitleText(context) {
  if (!context) return '';
  if (context.kind === 'mail') return truncate(context.mail && context.mail.subject ? context.mail.subject : context.title || 'Письмо', 80);
  if (context.kind === 'selection') return truncate(context.text || 'Выделенный фрагмент', 80);
  return truncate(context.title || 'Текущая страница', 80);
}

function mailSelectionKeyFor(message) {
  if (!message) return '';
  return `${String(message.from || '').slice(0, 120)}|${String(message.time || '').slice(0, 60)}`;
}

/** Нормализует focusIndex с учётом явного выбора в панели; выбор пропадает вместе с сообщением. */
function mailWithSelectedFocus(mail) {
  if (!mail || !Array.isArray(mail.messages) || !mail.messages.length) return mail;
  const count = mail.messages.length;
  let index = -1;
  if (state.mailSelectionKey) {
    index = mail.messages.findIndex((message) => mailSelectionKeyFor(message) === state.mailSelectionKey);
    if (index < 0) {
      state.mailSelectionKey = null;
      state.mailSelectionExplicit = false;
    }
  }
  if (index < 0) {
    const raw = Number.isInteger(mail.focusIndex) ? mail.focusIndex : count - 1;
    index = raw >= 0 && raw < count ? raw : count - 1;
  }
  return { ...mail, focusIndex: index };
}

function pickerSenderLabel(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const withoutEmail = raw.replace(/<[^>]*>/g, '').trim();
  return truncate(withoutEmail || raw, 34);
}

function renderMessageMeta() {
  const context = state.context;
  const mail = context && context.kind === 'mail' ? context.mail : null;
  const messages = mail && Array.isArray(mail.messages) ? mail.messages : [];
  if (!mail || !messages.length) {
    el.messageMeta.hidden = true;
    el.messageMeta.textContent = '';
    return;
  }
  const scope = state.settings.replyContext === 'thread' ? 'thread' : 'last';
  if (scope === 'thread') {
    const attachmentNames = new Set();
    for (const message of messages) {
      for (const name of Array.isArray(message.attachments) ? message.attachments : []) attachmentNames.add(name);
    }
    el.messageMeta.hidden = false;
    el.messageMeta.textContent = `Вся переписка · ${messages.length} писем · вложения: ${attachmentNames.size || 'нет'}`;
    return;
  }
  const index = Number.isInteger(mail.focusIndex)
    ? Math.min(Math.max(mail.focusIndex, 0), messages.length - 1)
    : messages.length - 1;
  const message = messages[index] || {};
  const from = pickerSenderLabel(message.from);
  const time = message.time ? ` · ${truncate(message.time, 30)}` : '';
  const count = Array.isArray(message.attachments) ? message.attachments.length : 0;
  el.messageMeta.hidden = false;
  el.messageMeta.textContent = `От: ${from || 'не определён'}${time} · ${count ? `вложения: ${count}` : 'без вложений'}`;
}

function renderMessagePicker() {
  const context = state.context;
  const mail = context && context.kind === 'mail' ? context.mail : null;
  const messages = mail && Array.isArray(mail.messages) ? mail.messages : [];
  const scope = state.settings.replyContext === 'thread' ? 'thread' : 'last';
  if (!mail || messages.length < 2 || scope !== 'last') {
    el.messagePicker.hidden = true;
    return;
  }
  const selected = Number.isInteger(mail.focusIndex)
    ? Math.min(Math.max(mail.focusIndex, 0), messages.length - 1)
    : messages.length - 1;
  el.messagePicker.hidden = false;
  el.messageSelect.textContent = '';
  messages.forEach((message, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const from = pickerSenderLabel(message.from);
    const attachmentName = Array.isArray(message.attachments) && message.attachments[0] ? message.attachments[0] : '';
    const textPreview = String(message.text || '').replace(/\s+/g, ' ').trim();
    // Без отправителя показываем превью/вложение, а не безликую «Письмо N».
    const label = from || truncate(attachmentName || textPreview, 48) || `Письмо ${index + 1}`;
    const time = message.time ? ` · ${truncate(message.time, 26)}` : '';
    const last = index === messages.length - 1 ? ' · последнее' : '';
    option.textContent = `${index + 1} · ${label}${time}${last}`;
    el.messageSelect.appendChild(option);
  });
  el.messageSelect.value = String(selected);
}

function renderContextBar() {
  const context = state.context;
  if (!context) {
    el.contextBar.hidden = true;
    el.contextScope.hidden = true;
    renderMessagePicker();
    renderMessageMeta();
    return;
  }
  el.contextBar.hidden = false;
  el.contextBar.classList.toggle('is-mail', context.kind === 'mail');
  el.contextIcon.setAttribute('href', context.kind === 'mail' ? '#i-mail' : context.kind === 'selection' ? '#i-sparkles' : '#i-page');
  el.contextKind.textContent = context.kind === 'mail' ? 'Письмо' : context.kind === 'selection' ? 'Выделение' : 'Страница';
  el.contextTitle.textContent = contextTitleText(context);
  const mail = context.kind === 'mail' ? context.mail : null;
  const messages = mail && Array.isArray(mail.messages) ? mail.messages : [];
  if (messages.length > 1) {
    const scope = state.settings.replyContext === 'thread' ? 'thread' : 'last';
    const focusIndex = Number.isInteger(mail.focusIndex) ? mail.focusIndex : messages.length - 1;
    const focused = messages[Math.min(Math.max(focusIndex, 0), messages.length - 1)];
    const explicit = state.mailSelectionExplicit || mail.focusSource === 'user';
    el.contextScope.hidden = false;
    el.contextScope.textContent =
      scope === 'thread' ? 'вся переписка' : explicit ? 'выбрано' : focusIndex === messages.length - 1 ? 'последнее' : 'открыто';
    el.contextScope.title = `Сообщение ${focusIndex + 1} из ${messages.length}${
      focused && focused.from ? ` · ${truncate(focused.from, 80)}` : ''
    }`;
  } else {
    el.contextScope.hidden = true;
  }
  renderMessagePicker();
  renderMessageMeta();
}

function setContext(context) {
  const next = context && typeof context === 'object' ? context : null;
  state.context =
    next && next.kind === 'mail' && next.mail ? { ...next, mail: mailWithSelectedFocus(next.mail) } : next;
  renderContextBar();
  updateQuickActions();
}

function updateQuickActions() {
  const hasMail = !!(state.context && state.context.kind === 'mail') || state.mailAvailable;
  el.btnReply.disabled = !hasMail || state.busy;
  el.btnSummary.disabled = !hasMail || state.busy;
  el.btnExplain.disabled = state.busy;
  // Пустой стейт: та же кнопка «Разобрать письмо…» должна включаться синхронно.
  const mailSuggestion = el.chat.querySelector('.suggestion[data-suggestion="mail"]');
  if (mailSuggestion) mailSuggestion.disabled = !hasMail || state.busy;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initContext() {
  const tab = await getActiveTab();
  if (!tab) {
    setContext(null);
    state.mailAvailable = false;
    updateQuickActions();
    return;
  }
  if (tab.restricted) {
    state.accessError = 'RESTRICTED_URL';
    setContext(null);
    state.mailAvailable = false;
    updateQuickActions();
    return;
  }
  if (state.context && state.context.kind === 'selection') {
    // Выделение не сбрасываем при обновлении вкладки, пока пользователь сам не уберёт.
    updateQuickActions();
    return;
  }
  // Оптимистично включаем почтовые действия ещё до инъекции: хост уже известен.
  if (tab.isMail) {
    state.mailAvailable = true;
    updateQuickActions();
  }
  const ensure = await ensureContent(tab.id);
  if (!ensure.ok) {
    state.accessError = ensure.reason || 'INJECT_FAILED';
    if (tab.isMail) {
      // Не гасим кнопки на почте: content script может доехать позже,
      // а действия при клике повторят ensure с ретраями.
      setContext({ kind: 'mail', title: 'Письмо', site: null });
    } else {
      setContext(null);
      state.mailAvailable = false;
    }
    updateQuickActions();
    return;
  }
  state.accessError = null;
  if (ensure.isMail) {
    // Подтверждаем почту сразу по PING — не ждём GET_MAIL.
    state.mailAvailable = true;
    updateQuickActions();
    const mailRes = await contentRequest('GET_MAIL');
    if (mailRes.ok) {
      state.mailAvailable = true;
      setContext({ kind: 'mail', mail: mailRes.mail, title: mailRes.mail.subject || 'Письмо', site: mailRes.mail.site });
    } else if (mailRes.reason === 'NOT_WEBMAIL') {
      // Логин-экран / нет открытого письма — почтовые действия не нужны.
      state.mailAvailable = false;
      setContext(null);
    } else {
      setContext({ kind: 'mail', title: 'Письмо', site: ensure.site || null });
    }
  } else {
    state.mailAvailable = false;
    setContext({ kind: 'page', title: tab.title || 'Страница', url: tab.url });
  }
  updateQuickActions();
}

function scheduleContextRefresh() {
  clearTimeout(contextRefreshTimer);
  contextRefreshTimer = setTimeout(() => {
    initContext().catch(() => {});
  }, 500);
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
  title.textContent = 'Чем помочь?';
  wrap.appendChild(title);

  const text = document.createElement('p');
  text.className = 'empty__text';
  text.textContent =
    'Почерк читает открытую страницу и письмо в Gmail, Outlook и Яндекс Почте, предлагает ответы и подстраивается под ваш стиль. Письма не отправляются — текст вставляете и отправляете вы сами.';
  wrap.appendChild(text);

  if (state.demo) {
    const demoNote = document.createElement('p');
    demoNote.className = 'notice';
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.style.background = 'var(--warning)';
    const label = document.createElement('span');
    label.textContent = 'Демо-режим: ключ не задан, ответы генерируются локально.';
    demoNote.append(dot, label);
    wrap.appendChild(demoNote);
  }

  const list = document.createElement('div');
  list.className = 'suggestions';

  const suggestions = [
    { icon: '#i-page', label: 'Объяснить эту страницу', run: () => explainPage() },
    { icon: '#i-mail', label: 'Разобрать письмо и предложить ответ', run: () => generateReply(), mail: true, disabled: !state.mailAvailable },
    { icon: '#i-sparkles', label: 'Что важного в этом тексте?', run: () => sendChat('Что важного в этом тексте?') },
  ];
  if (state.demo) {
    suggestions.push({ icon: '#i-sparkles', label: 'Показать демо-ответ', run: () => sendChat('Покажи на примере, как ты помогаешь с письмом') });
  }
  for (const suggestion of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    if (suggestion.mail) button.dataset.suggestion = 'mail';
    button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${suggestion.icon}"></use></svg>`;
    const label = document.createElement('span');
    label.textContent = suggestion.label;
    button.appendChild(label);
    button.disabled = !!suggestion.disabled || (!!suggestion.mail && state.busy);
    button.addEventListener('click', () => suggestion.run());
    list.appendChild(button);
  }
  wrap.appendChild(list);
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
    name.textContent = message.role === 'user' ? 'Вы' : 'Почерк';
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
    const copyButton = this.makeMiniButton('Копировать', '#i-copy', () => this.copyAll());
    this.actions.appendChild(copyButton);
    if (state.mailAvailable) {
      const insertButton = this.makeMiniButton('Вставить в письмо', '#i-insert', () => this.insertAll());
      this.actions.appendChild(insertButton);
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
    if (info.code === 'NO_HOST_ACCESS' || (message && message.meta && message.meta.accessError)) {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'ghost-btn';
      grant.textContent = 'Разрешить сайт';
      grant.addEventListener('click', async () => {
        const granted = await requestTabAccess();
        if (granted && action) {
          removeMessage(message);
          runAction(action);
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
  // Перед вставкой сверяем письмо: тема + отправитель/время выбранного сообщения.
  let weakSubject = false;
  if (state.context && state.context.kind === 'mail' && state.context.mail) {
    const fresh = await contentRequest('GET_MAIL');
    if (!fresh.ok || !fresh.mail) {
      await copyToClipboard(text);
      toast('Не удалось сверить открытое письмо — текст скопирован, вставьте вручную.', true);
      return false;
    }
    const expectedMail = state.context.mail;
    const expectedMessages = Array.isArray(expectedMail.messages) ? expectedMail.messages : [];
    const expectedIndex = Number.isInteger(expectedMail.focusIndex)
      ? Math.min(Math.max(expectedMail.focusIndex, 0), Math.max(0, expectedMessages.length - 1))
      : expectedMessages.length - 1;
    const expectedMessage = expectedMessages[expectedIndex] || {};
    const actualMessages = Array.isArray(fresh.mail.messages) ? fresh.mail.messages : [];
    const expectedKey = mailSelectionKeyFor(expectedMessage);
    const fromFound = Boolean(expectedKey) && actualMessages.some((message) => mailSelectionKeyFor(message) === expectedKey);
    const expectedSubject = String(expectedMail.subject || '');
    const actualSubject = String(fresh.mail.subject || '');
    const subjectComparable = Boolean(expectedSubject && actualSubject);
    const subjectMismatch = subjectComparable && expectedSubject !== actualSubject;
    weakSubject = !subjectComparable;
    if (subjectMismatch || !fromFound) {
      await copyToClipboard(text);
      toast('Письмо изменилось или не удалось его сверить — текст скопирован, вставьте вручную.', true);
      return false;
    }
  }
  const res = await contentRequest('INSERT_TEXT', { text });
  if (res.ok) {
    toast(
      weakSubject
        ? 'Вставлено. Тема письма не определена — сверили по отправителю и времени, проверьте текст.'
        : 'Вставлено в письмо. Проверьте текст перед отправкой.',
    );
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
  el.send.disabled = busy;
  el.stop.hidden = !busy;
  el.input.disabled = false;
  document.body.classList.toggle('is-busy', busy);
  updateQuickActions();
}

function historyForPrompt() {
  const session = findSession(state.activeId);
  if (!session) return [];
  return session.messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .slice(-LIMITS.historyMessages)
    .map((m) => ({ role: m.role, content: m.content }));
}

async function resolvePage() {
  const res = await contentRequest('GET_PAGE');
  if (res.ok && res.page) return { page: res.page };
  return { error: res };
}

async function resolveMail() {
  // Перед действием всегда перечитываем открытый тред: пользователь мог выбрать
  // другое письмо или перейти по SPA, пока панель была открыта.
  const res = await contentRequest('GET_MAIL');
  if (res.ok && res.mail) {
    setContext({ kind: 'mail', mail: res.mail, title: res.mail.subject || 'Письмо', site: res.mail.site });
    state.mailAvailable = true;
    updateQuickActions();
    return { mail: state.context && state.context.mail ? state.context.mail : res.mail };
  }
  // Мягкая деградация: не ломаем UX, если DOM временно не читается.
  if (state.context && state.context.kind === 'mail' && state.context.mail) {
    return { mail: state.context.mail, stale: true, error: res };
  }
  return { error: res };
}

function focusScopedMail(mail) {
  if (!mail || !Array.isArray(mail.messages) || !mail.messages.length) return mail;
  if (state.settings.replyContext === 'thread') return mail;
  if (mail.messages.length === 1) return { ...mail, focusIndex: 0 };
  const focusIndex = Number.isInteger(mail.focusIndex) ? mail.focusIndex : mail.messages.length - 1;
  const index = focusIndex >= 0 && focusIndex < mail.messages.length ? focusIndex : mail.messages.length - 1;
  return { ...mail, messages: [mail.messages[index]], focusIndex: 0 };
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
    meta: { streaming: true, demo: state.demo, kind: options.kind || task.kind, action: options.action || state.lastAction, accessError: options.accessError || null },
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
      message.meta.accessError = info.code === 'NO_HOST_ACCESS' ? 'NO_HOST_ACCESS' : null;
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

  // Сначала разрешаем контекст. Не добавляем сообщение в чат, пока он не подтверждён:
  // иначе при stale/недоступной странице останется вопрос без ответа.
  let context = null;
  let accessError = null;
  if (state.context && state.context.kind === 'selection') {
    context = { kind: 'selection', text: state.context.text };
  } else if (state.context && state.context.kind === 'mail') {
    const mail = await resolveMail();
    if (mail.stale) {
      toast('Контекст письма устарел — обновите страницу или панель и повторите.', true);
      return;
    }
    if (mail.mail) context = { kind: 'mail', mail: focusScopedMail(mail.mail) };
    else accessError = mail.error && mail.error.reason;
  } else {
    const page = await resolvePage();
    if (page.page) context = { kind: 'page', page: page.page };
    else accessError = page.error && page.error.reason;
  }

  const userMessage = { id: uid('msg'), role: 'user', content: text, ts: Date.now(), meta: {} };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);
  el.input.value = '';
  resizeInput();
  el.input.focus();

  if (accessError && state.demo) {
    // Демо-режиму не нужен доступ к странице: показываем локальный ответ.
    accessError = null;
  }
  if (accessError) {
    const message = {
      id: uid('msg'),
      role: 'assistant',
      content: '',
      ts: Date.now(),
      meta: { kind: 'chat', error: { title: 'Не удалось прочитать страницу', hint: accessErrorText(accessError), code: 'NO_HOST_ACCESS' }, action, accessError },
    };
    addMessage(message);
    const view2 = new MessageView(message);
    liveViews.set(message.id, view2);
    const empty = el.chat.querySelector('.empty');
    if (empty) empty.remove();
    el.chat.appendChild(view2.root);
    view2.showError(message.meta.error, message);
    scrollToBottom();
    chatFocus();
    return;
  }

  const task = buildChatTask({
    question: text,
    context,
    styleHints: styleHints(),
    history,
    contextScope: state.settings.replyContext === 'thread' ? 'thread' : 'last',
  });
  await executeTask(task, { kind: 'chat', action });
}

function chatFocus() {
  el.input.focus();
}

async function explainPage(extraQuestion = '') {
  if (state.busy) return;
  const pageResult = await resolvePage();
  let page = pageResult.page;
  if (!page) {
    if (!state.demo) {
      const reason = pageResult.error && pageResult.error.reason;
      toast(`Страница недоступна: ${accessErrorText(reason)}`, true);
      return;
    }
    // В демо-режиме разбор возможен и без доступа к странице.
    page = {
      title: (state.tab && state.tab.title) || 'Страница',
      text: '',
      url: (state.tab && state.tab.url) || '',
      headings: [],
    };
  }
  const userMessage = {
    id: uid('msg'),
    role: 'user',
    content: extraQuestion ? `Про страницу: ${extraQuestion}` : 'Объясни эту страницу',
    ts: Date.now(),
    meta: {},
  };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);

  const action = { name: 'explain', question: extraQuestion };
  state.lastAction = action;
  const task = buildExplainTask({ page: pageResult.page, styleHints: styleHints(), question: extraQuestion });
  await executeTask(task, { kind: 'explain', action });
}

async function generateReply(intent = '') {
  if (state.busy) return;
  const mailResult = await resolveMail();
  if (!mailResult.mail) {
    const reason = mailResult.error && mailResult.error.reason;
    toast(reason === 'NOT_WEBMAIL' ? 'Откройте письмо в Gmail, Outlook или Яндекс Почте' : accessErrorText(reason), true);
    return;
  }
  if (mailResult.stale) {
    toast('Контекст письма устарел — обновите страницу или панель и повторите.', true);
    return;
  }
  const userMessage = {
    id: uid('msg'),
    role: 'user',
    content: intent ? `Ответь на письмо. ${intent}` : 'Предложи ответ на письмо',
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
  const contextScope = settings.replyContext === 'last' ? 'last' : 'thread';
  const mail = focusScopedMail(mailResult.mail);
  const task = buildReplyTask({
    mail,
    styleHints: styleHints(),
    variants: 3,
    intent,
    instruction: settings.replyInstruction,
    contextScope,
  });
  await executeTask(task, { kind: 'reply', variantMode: true, action });
}

async function generateSummary() {
  if (state.busy) return;
  const mailResult = await resolveMail();
  if (!mailResult.mail) {
    const reason = mailResult.error && mailResult.error.reason;
    toast(reason === 'NOT_WEBMAIL' ? 'Откройте письмо в Gmail, Outlook или Яндекс Почте' : accessErrorText(reason), true);
    return;
  }
  if (mailResult.stale) {
    toast('Контекст письма устарел — обновите страницу или панель и повторите.', true);
    return;
  }
  const contextScope = state.settings.replyContext === 'thread' ? 'thread' : 'last';
  const userMessage = {
    id: uid('msg'),
    role: 'user',
    content: contextScope === 'last' ? 'Разбери выбранное письмо' : 'Разбери переписку',
    ts: Date.now(),
    meta: {},
  };
  addMessage(userMessage);
  const view = new MessageView(userMessage);
  liveViews.set(userMessage.id, view);
  if (!el.chat.querySelector('.msg')) el.chat.textContent = '';
  el.chat.appendChild(view.root);
  scrollToBottom(true);

  const action = { name: 'summary' };
  state.lastAction = action;
  const task = buildSummaryTask({ mail: focusScopedMail(mailResult.mail), styleHints: styleHints(), contextScope });
  await executeTask(task, { kind: 'summary', action });
}

function runAction(action) {
  if (!action) return;
  if (action.name === 'chat') return sendChat(action.question);
  if (action.name === 'explain') return explainPage(action.question || '');
  if (action.name === 'reply') return generateReply(action.intent || '');
  if (action.name === 'summary') return generateSummary();
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

function voiceAvailable() {
  return !!SpeechRecognitionCtor && state.settings.voice.enabled;
}

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
  el.input.addEventListener('input', resizeInput);
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
  el.send.addEventListener('click', () => resizeInput());
  el.btnExplain.addEventListener('click', () => explainPage());
  el.btnReply.addEventListener('click', () => generateReply());
  el.btnSummary.addEventListener('click', () => generateSummary());
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
  el.contextRemove.addEventListener('click', () => {
    setContext(null);
    toast('Контекст убран');
  });
  el.messageSelect.addEventListener('change', () => {
    const context = state.context;
    const mail = context && context.kind === 'mail' ? context.mail : null;
    if (!mail || !Array.isArray(mail.messages)) return;
    const index = Number(el.messageSelect.value);
    if (!Number.isInteger(index) || index < 0 || index >= mail.messages.length) return;
    state.mailSelectionKey = mailSelectionKeyFor(mail.messages[index]);
    state.mailSelectionExplicit = true;
    state.context = { ...context, mail: { ...mail, focusIndex: index } };
    renderContextBar();
    renderMessagePicker();
    updateQuickActions();
  });
  el.contextRefresh.addEventListener('click', async () => {
    state.context = null;
    await initContext();
    toast('Контекст обновлён');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.voice.active) stopVoice();
      if (!el.drawer.hidden) closeDrawer();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CONTEXT_PUSH') {
      const context = message.context;
      if (context && typeof context === 'object') {
        if (context.kind === 'mail' && context.mail) {
          setContext({ kind: 'mail', mail: context.mail, title: context.mail.subject || 'Письмо', site: context.mail.site });
          state.mailAvailable = true;
        } else if (context.kind === 'selection' && context.text) {
          setContext({ kind: 'selection', text: context.text, title: context.title || '' });
        } else if (context.kind === 'page' && context.page) {
          setContext({ kind: 'page', page: context.page, title: context.page.title || 'Страница', url: context.page.url });
        }
        chatFocus();
      }
      if (message.requestPage) {
        explainPage().catch(() => {});
      }
      // Pending уже доставлен push-ем — не даём ему всплыть при следующем открытии.
      try {
        const cleared = chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CONTEXT' });
        if (cleared && typeof cleared.catch === 'function') cleared.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    if (message.type === 'MAIL_CONTEXT_CHANGED' && message.mail && Array.isArray(message.mail.messages) && message.mail.messages.length) {
      // SPA: пользователь выбрал другое сообщение/открыл другое письмо при открытой панели.
      if (state.context && state.context.kind === 'selection') return;
      if (message.mail.focusSource === 'user') {
        // Клик по сообщению в странице — явный выбор, он важнее выбора в панели.
        state.mailSelectionKey = null;
        state.mailSelectionExplicit = false;
      }
      state.mailAvailable = true;
      setContext({ kind: 'mail', mail: message.mail, title: message.mail.subject || 'Письмо', site: message.mail.site });
      updateQuickActions();
      return;
    }
    if (message.type === 'REFRESH_CONTEXT') scheduleContextRefresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      state.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      state.theme = state.settings.theme;
      applyTheme();
      refreshVoiceUi();
      refreshProviderState();
      renderContextBar();
      renderMessagePicker();
    }
    if (changes[STORAGE_KEYS.profile]) {
      state.profile = normalizeProfile(changes[STORAGE_KEYS.profile].newValue);
    }
  });
  chrome.tabs.onActivated.addListener(() => scheduleContextRefresh());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete' || info.url) scheduleContextRefresh();
  });
}

async function consumePendingContext() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PENDING_CONTEXT', clear: true });
    const context = res && res.context;
    if (!context || typeof context !== 'object') return false;
    if (context.requestPage) state.pendingRequestPage = true;
    if (context.kind === 'mail' && context.mail) {
      setContext({ kind: 'mail', mail: context.mail, title: context.mail.subject || 'Письмо', site: context.mail.site });
      state.mailAvailable = true;
    } else if (context.kind === 'selection' && context.text) {
      setContext({ kind: 'selection', text: context.text, title: context.title || '' });
    } else if (context.kind === 'page' && context.page) {
      setContext({ kind: 'page', page: context.page, title: context.page.title || 'Страница', url: context.page.url });
    }
    return true;
  } catch {
    return false;
  }
}

async function init() {
  try {
    await loadState();
  } catch (error) {
    console.warn('[Почерк] loadState:', error);
  }
  applyTheme();
  refreshVoiceUi();
  resizeInput();
  await refreshProviderState();
  bindEvents();
  // Сначала выясняем контекст вкладки, потом рендерим пустой стейт:
  // иначе почтовые кнопки создаются disabled и не всегда успевают обновиться.
  await consumePendingContext();
  try {
    await initContext();
  } catch (error) {
    console.warn('[Почерк] initContext:', error);
  }
  renderChat();
  updateQuickActions();
  chatFocus();
  if (state.pendingRequestPage) {
    state.pendingRequestPage = false;
    explainPage().catch(() => {});
  }
}

init().catch((error) => {
  console.error('[Почерк] init failed', error);
  renderChat();
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = `Не удалось запустить панель: ${error && error.message ? error.message : error}`;
  el.chat.appendChild(box);
});
