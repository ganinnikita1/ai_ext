/**
 * lib/config.js — defaults, storage keys, provider presets, small helpers.
 * No network, no DOM assumptions shared with background (imported by the SW too).
 */

export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  profile: 'styleProfile',
  chat: 'chatSessions',
  pending: 'pendingContext',
});

export const DEFAULT_SETTINGS = Object.freeze({
  // Схема 3: провайдер/модель зафиксированы, контекст по умолчанию — выбранное сообщение.
  schema: 3,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  temperature: 0.4,
  maxTokens: 700,
  streaming: true,
  theme: 'auto', // 'auto' | 'light' | 'dark'
  // Контекст для ответа/сводки/вопроса: выбранное сообщение ('last') или вся переписка ('thread').
  replyContext: 'last', // 'last' = выбранное/последнее, 'thread' = вся переписка
  replyInstruction: '',
  voice: {
    enabled: true,
    lang: 'ru-RU',
    autoSend: false,
  },
});

export const PROVIDER_PRESETS = Object.freeze({
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash'],
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'Модель зафиксирована: deepseek-flash. Reasoning: high (thinking enabled). Base URL: https://api.deepseek.com.',
  },
  openai: {
    label: 'OpenAI-совместимый',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'OpenAI, Azure OpenAI, OpenRouter, Together, LM Studio, vLLM и любые серверы с /chat/completions.',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Заголовок anthropic-dangerous-direct-browser-access добавляется автоматически.',
  },
  ollama: {
    label: 'Ollama (локально)',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1',
    models: ['llama3.1', 'qwen2.5', 'mistral'],
    needsKey: false,
    keyUrl: 'https://ollama.com/download',
    hint: 'Ключ не нужен. Сервер Ollama должен быть запущен на этой машине.',
  },
});

export const VOICE_LANGS = Object.freeze([
  { id: 'ru-RU', label: 'Русский (ru-RU)' },
  { id: 'en-US', label: 'English (en-US)' },
  { id: 'en-GB', label: 'English (en-GB)' },
  { id: 'de-DE', label: 'Deutsch (de-DE)' },
  { id: 'fr-FR', label: 'Français (fr-FR)' },
  { id: 'es-ES', label: 'Español (es-ES)' },
]);

export const LIMITS = Object.freeze({
  pageChars: 14000,
  mailChars: 12000,
  selectionChars: 4000,
  composerChars: 6000,
  historyMessages: 16,
  maxSessions: 20,
  maxSamples: 30,
  requestTimeoutMs: 90000,
  firstTokenTimeoutMs: 45000,
  maxRetries: 2,
});

export const YANDEX_MAIL_HOSTS = Object.freeze([
  // Яндекс Почта (потребительская)
  'mail.yandex.ru',
  'mail.yandex.com',
  'mail.yandex.by',
  'mail.yandex.kz',
  'mail.yandex.com.tr',
  'mail.yandex.az',
  'mail.yandex.co.il',
  'mail.yandex.ua',
  // Яндекс 360 для бизнеса (классический BEM-UI)
  'mail.360.yandex.ru',
  'mail.360.yandex.com',
  'mail.360.yandex.by',
  'mail.360.yandex.kz',
  'mail.360.yandex.com.tr',
  'mail.360.yandex.az',
  'mail.360.yandex.co.il',
  'mail.360.yandex.ua',
]);

export const WEBMAIL_HOSTS = Object.freeze([
  'mail.google.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.live.com',
  ...YANDEX_MAIL_HOSTS,
]);

// mail.yandex.* и mail.360.yandex.*; lookalike-домены (mail.360.yandex.ru.evil.com) не проходят.
const YANDEX_SUFFIX_RE = /^(?:mail\.yandex|mail\.360\.yandex)\.(?:ru|com|by|kz|com\.tr|az|co\.il|ua)$/;

/** true для любого домена веб-почты, включая зеркала Яндекс Почты. */
export function isWebmailHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return WEBMAIL_HOSTS.includes(host) || YANDEX_SUFFIX_RE.test(host);
}

export const VARIANT_MARKER = '### ВАРИАНТ';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Trim, add scheme when missing, drop trailing slashes. Returns '' when unusable. */
export function normalizeBaseUrl(raw, provider = 'openai') {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = (provider === 'ollama' ? 'http://' : 'https://') + value;
  }
  value = value.replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (!url.hostname) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/** Origin match pattern for chrome.permissions, e.g. "https://api.openai.com/*". */
export function originPattern(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/** Full chat endpoint for a provider. */
export function chatEndpoint(settings) {
  const base = normalizeBaseUrl(settings.baseUrl, settings.provider);
  if (!base) return '';
  if (settings.provider === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (settings.provider === 'ollama') {
    if (/\/api\/chat$/.test(base)) return base;
    return `${base}/api/chat`;
  }
  // DeepSeek — OpenAI-формат, но base URL без /v1: https://api.deepseek.com/chat/completions.
  if (settings.provider === 'deepseek') {
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** API root (used by "test connection"): endpoint minus the operation suffix. */
export function apiRoot(settings) {
  const endpoint = chatEndpoint(settings);
  if (!endpoint) return '';
  return endpoint
    .replace(/\/chat\/completions$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/api\/chat$/, '');
}

export function isDemoMode(settings) {
  const s = normalizeSettings(settings);
  if (s.provider === 'ollama') return false; // local server, no key required
  return !String(s.apiKey || '').trim();
}

export function providerNeedsKey(provider) {
  return provider !== 'ollama';
}

export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const voiceRaw = input.voice && typeof input.voice === 'object' ? input.voice : {};
  const voiceEnabled = typeof voiceRaw.enabled === 'boolean' ? voiceRaw.enabled : DEFAULT_SETTINGS.voice.enabled;
  const voiceLang = VOICE_LANGS.some((l) => l.id === voiceRaw.lang) ? voiceRaw.lang : DEFAULT_SETTINGS.voice.lang;
  // Схема 3: семантика контекста изменилась на «выбранное сообщение» — старые
  // профили (schema < 3) переводим на новый дефолт, явный выбор пользователя сохраняем.
  const legacyContext = input.schema !== 3;
  // Миграция: старые настройки с openai/anthropic/ollama или другой моделью
  // принудительно приводим к фиксированному профилю DeepSeek flash.
  return {
    schema: 3,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: String(input.apiKey || '').trim(),
    temperature: clamp(input.temperature ?? DEFAULT_SETTINGS.temperature, 0, 1),
    maxTokens: Math.round(clamp(input.maxTokens ?? DEFAULT_SETTINGS.maxTokens, 128, 4000)),
    streaming: input.streaming !== false,
    theme: ['auto', 'light', 'dark'].includes(input.theme) ? input.theme : 'auto',
    replyContext: legacyContext || input.replyContext !== 'thread' ? 'last' : 'thread',
    replyInstruction: String(input.replyInstruction || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    voice: {
      enabled: voiceEnabled,
      lang: voiceLang,
      autoSend: voiceRaw.autoSend === true,
    },
  };
}

/** Deep-ish merge for chat sessions / profile stored by older versions. */
export function safeParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
