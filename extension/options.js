/**
 * options.js — минималистичные настройки: только API-ключ DeepSeek.
 * Модель и адрес обработки зафиксированы в коде; в UI их не выбрать.
 * Плюс стиль письма, голос и приватность. Стиль bb.
 */

import {
  STORAGE_KEYS,
  VOICE_LANGS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  originPattern,
  isDemoMode,
} from './lib/config.js';
import { testConnection, describeLLMError } from './lib/llm-client.js';
import { normalizeProfile, clearLearning, profileStats } from './lib/style-profile.js';

const $ = (id) => document.getElementById(id);

const el = {
  version: $('app-version'),
  apiKey: $('apiKey'),
  toggleKey: $('btn-toggle-key'),
  streaming: $('streaming'),
  testResult: $('test-result'),
  testIcon: $('test-icon'),
  testTitle: $('test-title'),
  testHint: $('test-hint'),
  btnTest: $('btn-test'),
  btnSave: $('btn-save'),
  btnReset: $('btn-reset'),
  formality: $('formality'),
  formalityOut: $('formality-out'),
  length: $('length'),
  emoji: $('emoji'),
  signoff: $('signoff'),
  signature: $('signature'),
  replyInstruction: $('replyInstruction'),
  styleBadge: $('style-badge'),
  learnedList: $('learned-list'),
  btnClearStyle: $('btn-clear-style'),
  btnExport: $('btn-export'),
  voiceEnabled: $('voice-enabled'),
  voiceLang: $('voice-lang'),
  voiceAutosend: $('voice-autosend'),
  voiceBadge: $('voice-badge'),
  voiceSupport: $('voice-support'),
  btnVoiceTest: $('btn-voice-test'),
  toast: $('toast'),
};

const state = {
  settings: normalizeSettings(null),
  profile: normalizeProfile(null),
};

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
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
  }, 2800);
}

function readRadio(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : '';
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const theme = state.settings.theme;
  document.documentElement.dataset.theme = theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme;
}

darkQuery.addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});

/* ------------------------------------------------------------------ */
/* form                                                                */
/* ------------------------------------------------------------------ */

function fillVoiceLanguages(selected) {
  el.voiceLang.textContent = '';
  for (const lang of VOICE_LANGS) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.textContent = lang.label;
    el.voiceLang.appendChild(option);
  }
  el.voiceLang.value = selected;
}

function applyForm(settings, profile) {
  el.apiKey.value = settings.apiKey;
  el.streaming.checked = settings.streaming;

  fillVoiceLanguages(settings.voice.lang);
  el.voiceEnabled.checked = settings.voice.enabled;
  el.voiceAutosend.checked = settings.voice.autoSend;

  el.formality.value = String(profile.prefs.formality);
  el.formalityOut.textContent = String(profile.prefs.formality);
  el.length.value = profile.prefs.length;
  el.emoji.value = profile.prefs.emoji;
  el.signoff.value = profile.prefs.signoff;
  el.signature.value = profile.prefs.signature;
  const address = document.querySelector(`input[name="address"][value="${profile.prefs.address}"]`);
  if (address) address.checked = true;
  el.replyInstruction.value = settings.replyInstruction;

  renderLearned();
  renderVoiceAvailability();
}

function readForm() {
  const settings = normalizeSettings({
    ...state.settings,
    apiKey: el.apiKey.value.trim(),
    streaming: el.streaming.checked,
    replyInstruction: el.replyInstruction.value,
    voice: {
      enabled: el.voiceEnabled.checked,
      lang: el.voiceLang.value,
      autoSend: el.voiceAutosend.checked,
    },
  });
  const profile = normalizeProfile({
    ...state.profile,
    prefs: {
      formality: Number(el.formality.value) || 3,
      length: el.length.value,
      emoji: el.emoji.value,
      address: readRadio('address') === 'ты' ? 'ты' : 'вы',
      signoff: el.signoff.value.trim(),
      signature: el.signature.value.trim(),
    },
  });
  return { settings, profile };
}

/* ------------------------------------------------------------------ */
/* learned rules / voice                                               */
/* ------------------------------------------------------------------ */

function renderLearned() {
  el.learnedList.textContent = '';
  const stats = profileStats(state.profile);
  el.styleBadge.textContent = `${stats.samples} примеров`;
  el.styleBadge.className = stats.samples ? 'badge badge--ok' : 'badge';
  const rules = state.profile.rules || [];
  if (!rules.length) {
    const empty = document.createElement('li');
    empty.className = 'learned__empty';
    empty.textContent =
      'Пока правил нет. Сгенерируйте ответ, вставьте его, поправьте текст в композере и нажмите «Учиться на правке» в панели.';
    el.learnedList.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const item = document.createElement('li');
    item.textContent = rule.text;
    el.learnedList.appendChild(item);
  }
}

function renderVoiceAvailability() {
  const enabled = el.voiceEnabled.checked;
  if (!SpeechRecognitionCtor) {
    el.voiceBadge.textContent = 'нет';
    el.voiceBadge.className = 'badge badge--warning';
    el.voiceSupport.textContent = 'Браузер не поддерживает распознавание речи.';
    return;
  }
  el.voiceBadge.textContent = enabled ? 'доступен' : 'выключен';
  el.voiceBadge.className = enabled ? 'badge badge--ok' : 'badge';
  const langLabel = VOICE_LANGS.find((l) => l.id === el.voiceLang.value);
  el.voiceSupport.textContent = `Распознаёт браузер (${langLabel ? langLabel.label : el.voiceLang.value}).`;
}

function renderTestResult(kind, title, hint = '') {
  el.testResult.hidden = false;
  el.testResult.className = `test-result is-${kind}`;
  el.testIcon.setAttribute('href', kind === 'error' ? '#i-alert' : '#i-check');
  el.testTitle.textContent = title;
  el.testHint.textContent = hint;
}

/* ------------------------------------------------------------------ */
/* save / test / reset                                                 */
/* ------------------------------------------------------------------ */

async function persist(settings, profile) {
  state.settings = settings;
  state.profile = profile;
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.profile]: profile,
  });
  applyTheme();
}

/** Запрос доступа к домену DeepSeek. Вызывать из обработчика клика (жест). */
function requestProviderPermission(settings) {
  const pattern = originPattern(settings.baseUrl);
  if (!pattern) return Promise.resolve(false);
  try {
    return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function onSave() {
  const { settings, profile } = readForm();
  // Вызов chrome.permissions.request должен идти сразу из жеста.
  const permissionPromise = requestProviderPermission(settings);
  (async () => {
    const granted = await permissionPromise;
    await persist(settings, profile);
    toast(granted ? 'Сохранено' : 'Сохранено. Разрешите доступ к api.deepseek.com при запросе.', !granted);
  })().catch((error) => toast(`Не удалось сохранить: ${error && error.message ? error.message : error}`, true));
}

function onTest() {
  const { settings, profile } = readForm();
  if (isDemoMode(settings)) {
    renderTestResult('error', 'Вставьте API-ключ', 'Без ключа работает демо-режим.');
    el.apiKey.focus();
    return;
  }
  renderTestResult('pending', 'Проверяем соединение…', '');
  const permissionPromise = requestProviderPermission(settings);
  (async () => {
    const granted = await permissionPromise;
    if (!granted) {
      renderTestResult('error', 'Нет доступа к api.deepseek.com', 'Разрешите домен в запросе браузера.');
      return;
    }
    await persist(settings, profile);
    const result = await testConnection({ settings });
    renderTestResult(result.ok ? 'ok' : 'error', result.message, result.hint || '');
    toast(result.ok ? 'Соединение работает' : 'Проверка не удалась', !result.ok);
  })().catch((error) => {
    const info = describeLLMError(error);
    renderTestResult('error', info.title, info.hint || '');
  });
}

function onReset() {
  const confirmed = window.confirm('Удалить ключ, настройки, историю чатов и данные обучения стилю?');
  if (!confirmed) return;
  (async () => {
    await chrome.storage.local.remove([STORAGE_KEYS.settings, STORAGE_KEYS.profile, STORAGE_KEYS.chat]);
    try {
      const all = await chrome.permissions.getAll();
      const origins = (all.origins || []).filter((origin) => origin.startsWith('http'));
      if (origins.length) await chrome.permissions.remove({ origins });
    } catch {
      /* ignore */
    }
    state.settings = normalizeSettings(DEFAULT_SETTINGS);
    state.profile = normalizeProfile(null);
    applyForm(state.settings, state.profile);
    el.testResult.hidden = true;
    toast('Сброшено');
  })().catch((error) => toast(`Сброс не удался: ${error && error.message ? error.message : error}`, true));
}

async function onClearStyle() {
  if (!window.confirm('Удалить все примеры и выученные правила стиля?')) return;
  state.profile = clearLearning(state.profile);
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: state.profile });
  renderLearned();
  toast('Обучение стилю очищено');
}

function onExport() {
  const payload = {
    app: 'aibro',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    note: 'API-ключ не экспортируется.',
    settings: { ...state.settings, apiKey: '' },
    profile: state.profile,
  };
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aibro-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Профиль экспортирован');
  } catch (error) {
    toast(`Экспорт не удался: ${error && error.message ? error.message : error}`, true);
  }
}

function onVoiceTest() {
  renderVoiceAvailability();
  if (!SpeechRecognitionCtor) {
    toast('Распознавание речи недоступно в этом браузере', true);
    return;
  }
  toast('Голосовой ввод поддерживается. Микрофон запрашивается при первом использовании.');
}

/* ------------------------------------------------------------------ */
/* bindings / init                                                     */
/* ------------------------------------------------------------------ */

function bind() {
  el.formality.addEventListener('input', () => {
    el.formalityOut.textContent = el.formality.value;
  });
  el.voiceEnabled.addEventListener('change', renderVoiceAvailability);
  el.voiceLang.addEventListener('change', renderVoiceAvailability);
  el.toggleKey.addEventListener('click', () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.toggleKey.setAttribute('aria-label', show ? 'Скрыть ключ' : 'Показать ключ');
  });
  el.btnSave.addEventListener('click', onSave);
  el.btnTest.addEventListener('click', onTest);
  el.btnReset.addEventListener('click', onReset);
  el.btnClearStyle.addEventListener('click', onClearStyle);
  el.btnExport.addEventListener('click', onExport);
  el.btnVoiceTest.addEventListener('click', onVoiceTest);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      state.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      applyTheme();
    }
    if (changes[STORAGE_KEYS.profile]) {
      state.profile = normalizeProfile(changes[STORAGE_KEYS.profile].newValue);
      renderLearned();
    }
  });
}

async function init() {
  el.version.textContent = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.profile]);
  state.settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  state.profile = normalizeProfile(stored[STORAGE_KEYS.profile]);
  // Миграция старых настроек (провайдер/модель) к фиксированному DeepSeek flash.
  const rawSettings = stored[STORAGE_KEYS.settings];
  if (!rawSettings || rawSettings.schema !== 3 || rawSettings.provider !== 'deepseek' || rawSettings.model !== 'deepseek-flash') {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: state.settings });
  }
  applyTheme();
  applyForm(state.settings, state.profile);
  bind();
}

init().catch((error) => {
  console.error('[AI Bro options] init failed', error);
  toast(`Ошибка инициализации настроек: ${error && error.message ? error.message : error}`, true);
});
