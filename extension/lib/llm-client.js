/**
 * lib/llm-client.js — единственный модуль, который ходит в сеть.
 *
 * Поддерживает:
 *  - OpenAI-совместимые API (POST /chat/completions, SSE);
 *  - Anthropic Messages API (POST /messages, SSE);
 *  - Ollama (POST /api/chat, NDJSON).
 *
 * Никакого remote code: только fetch к адресу, который выбрал пользователь.
 */

import {
  LIMITS,
  normalizeSettings,
  chatEndpoint,
  apiRoot,
  originPattern,
  isDemoMode,
} from './config.js';

export class LLMError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = meta.status || 0;
    this.retryable = meta.retryable === true;
    this.hint = meta.hint || '';
  }
}

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

export async function hasOriginPermission(settings) {
  const origin = originPattern(settings && settings.baseUrl);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Must be called from a user gesture (button click) in an extension page. */
export async function requestOriginPermission(settings) {
  const origin = originPattern(settings && settings.baseUrl);
  if (!origin) throw new LLMError('BAD_CONFIG', 'Некорректный base URL: не удалось определить домен провайдера.');
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    throw new LLMError('PERMISSION', `Не удалось запросить доступ к ${origin}: ${error && error.message ? error.message : 'ошибка'}`);
  }
}

/* ------------------------------------------------------------------ */
/* request building                                                    */
/* ------------------------------------------------------------------ */

function normalizeMessages(task) {
  const list = Array.isArray(task.messages) ? task.messages : [];
  return list
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

export function buildRequest(settings, task, { stream = true } = {}) {
  const s = normalizeSettings(settings);
  const endpoint = chatEndpoint(s);
  if (!endpoint) throw new LLMError('BAD_CONFIG', 'Некорректный base URL: проверьте настройки провайдера.');
  const model = String(s.model || '').trim();
  if (!model) throw new LLMError('BAD_CONFIG', 'Не указана модель.');
  const messages = normalizeMessages(task);
  if (!messages.length) throw new LLMError('BAD_CONFIG', 'Пустой запрос: нет сообщений.');
  const temperature = typeof task.temperature === 'number' ? task.temperature : s.temperature;
  const maxTokens = Math.round(
    Math.min(4000, Math.max(64, Number(task.maxTokens) || s.maxTokens || 700)),
  );
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (s.provider === 'anthropic') {
    if (!s.apiKey) throw new LLMError('NO_KEY', 'Не задан API-ключ Anthropic.');
    headers['x-api-key'] = s.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Позволяет вызывать API из расширения без прокси-сервера.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
      stream,
    };
    if (task.system) body.system = String(task.system);
  } else if (s.provider === 'ollama') {
    body = {
      model,
      messages: [{ role: 'system', content: String(task.system || '') }, ...messages],
      stream,
      options: { temperature, num_predict: maxTokens },
    };
  } else {
    if (!s.apiKey) throw new LLMError('NO_KEY', 'Добавьте API-ключ DeepSeek в настройках.');
    headers.Authorization = `Bearer ${s.apiKey}`;
    body = {
      model,
      messages: [{ role: 'system', content: String(task.system || '') }, ...messages],
      temperature,
      max_tokens: maxTokens,
      stream,
    };
  }

  // DeepSeek: reasoning включён на среднем уровне (reasoning_effort medium → high на сервере).
  // Это даёт более качественные черновики; в thinking-режиме DeepSeek игнорирует temperature,
  // но мы всё равно отправляем её — это допустимо. Параметр только для deepseek.
  if (s.provider === 'deepseek') {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = 'medium';
  }

  return { url: endpoint, headers, body, provider: s.provider };
}

/* ------------------------------------------------------------------ */
/* streaming plumbing                                                  */
/* ------------------------------------------------------------------ */

async function* lineIterator(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    try {
      reader.cancel();
    } catch {
      /* уже закрыт */
    }
  }
}

function extractToken(provider, payload) {
  if (provider === 'anthropic') {
    if (payload.type === 'error') {
      const message = payload.error && payload.error.message ? payload.error.message : 'ошибка потока';
      throw new LLMError('PROVIDER', `Anthropic: ${message}`, { retryable: false });
    }
    if (payload.type === 'content_block_delta' && payload.delta && typeof payload.delta.text === 'string') {
      return payload.delta.text;
    }
    return '';
  }
  if (provider === 'ollama') {
    if (payload.error) throw new LLMError('PROVIDER', `Ollama: ${payload.error}`);
    if (payload.message && typeof payload.message.content === 'string') return payload.message.content;
    return '';
  }
  // openai-compatible
  if (payload.error) {
    const message = typeof payload.error === 'string' ? payload.error : payload.error.message || 'ошибка потока';
    throw new LLMError('PROVIDER', `Провайдер: ${message}`);
  }
  const choice = payload.choices && payload.choices[0];
  if (!choice) return '';
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  return '';
}

function parseNonStream(provider, data) {
  if (provider === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content : [];
    return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  }
  if (provider === 'ollama') {
    return data.message && typeof data.message.content === 'string' ? data.message.content : '';
  }
  const choice = data.choices && data.choices[0];
  if (!choice) return '';
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

function mapHttpError(status, bodyText) {
  const snippet = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 400);
  if (status === 401 || status === 403) {
    return new LLMError('AUTH', `Ключ не принят провайдером (HTTP ${status}).`, {
      status,
      hint: 'Проверьте API-ключ в настройках и что у ключа есть доступ к выбранной модели.',
    });
  }
  if (status === 404) {
    return new LLMError('NOT_FOUND', 'Провайдер вернул 404: не найден endpoint или модель.', {
      status,
      hint: 'Проверьте соединение в настройках расширения.',
    });
  }
  if (status === 429) {
    return new LLMError('RATE_LIMIT', 'Слишком много запросов или закончилась квота (HTTP 429).', {
      status,
      retryable: true,
      hint: 'Подождите минуту или проверьте лимиты аккаунта.',
    });
  }
  if (status === 402) {
    return new LLMError('BALANCE', 'Недостаточно средств на балансе провайдера (HTTP 402).', {
      status,
      hint: 'Пополните баланс в кабинете DeepSeek.',
    });
  }
  if (status === 400 || status === 422) {
    return new LLMError('BAD_REQUEST', `Провайдер отклонил запрос (HTTP ${status}).`, {
      status,
      hint: snippet ? `Ответ провайдера: ${snippet}` : 'Проверьте модель, max_tokens и формат base URL.',
    });
  }
  if (status >= 500) {
    return new LLMError('SERVER', `Ошибка на стороне провайдера (HTTP ${status}).`, {
      status,
      retryable: true,
      hint: 'Повторите через несколько секунд.',
    });
  }
  return new LLMError('HTTP', `Провайдер вернул HTTP ${status}.`, { status, hint: snippet });
}

function networkError(error) {
  const message = error && error.message ? error.message : 'сеть недоступна';
  return new LLMError('NETWORK', 'Не удалось связаться с провайдером.', {
    retryable: true,
    hint: `Проверьте интернет, base URL и разрешение расширения на этот домен. Детали: ${message}`,
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new LLMError('ABORTED', 'Остановлено'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new LLMError('ABORTED', 'Остановлено'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* main API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Стримит ответ модели.
 * @param {object} options
 * @param {object} options.settings
 * @param {{system:string,messages:Array,maxTokens?:number,temperature?:number}} options.task
 * @param {AbortSignal} [options.signal]
 * @yields {{type:'token',text:string}|{type:'done',text:string}}
 */
export async function* streamTask({ settings, task, signal }) {
  const s = normalizeSettings(settings);
  if (isDemoMode(s)) {
    throw new LLMError('DEMO', 'Демо-режим: ключ не задан.');
  }
  if (!(await hasOriginPermission(s))) {
    const origin = originPattern(s.baseUrl) || s.baseUrl;
    throw new LLMError('NO_PERMISSION', `Нет доступа к ${origin}.`, {
      hint: 'Разрешите доступ к домену провайдера в настройках расширения (кнопка «Проверить соединение»).',
    });
  }

  let request = buildRequest(s, task, { stream: s.streaming });
  let attempt = 0;
  let fallbackTried = false;

  for (;;) {
    const controller = new AbortController();
    let userAborted = false;
    let timedOut = false;
    let firstTokenSeen = false;
    let full = '';
    let firstTokenTimer = null;
    let totalTimer = null;

    const abortFromUser = () => {
      userAborted = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) throw new LLMError('ABORTED', 'Остановлено');
      signal.addEventListener('abort', abortFromUser, { once: true });
    }
    // Только для стрима: в non-stream первый байт приходит вместе с полным ответом.
    if (request.body.stream) {
      firstTokenTimer = setTimeout(() => {
        if (!firstTokenSeen) {
          timedOut = true;
          controller.abort();
        }
      }, LIMITS.firstTokenTimeoutMs);
    }
    totalTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LIMITS.requestTimeoutMs);

    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });

      if (!response.ok) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          bodyText = '';
        }
        throw mapHttpError(response.status, bodyText);
      }

      if (!request.body.stream) {
        const data = await response.json();
        full = parseNonStream(request.provider, data);
        firstTokenTimer && clearTimeout(firstTokenTimer);
        if (!full.trim()) {
          throw new LLMError('BAD_RESPONSE', 'Провайдер вернул пустой ответ.', { retryable: true });
        }
        yield { type: 'done', text: full };
        return;
      }

      let doneSeen = false;
      for await (const line of lineIterator(response)) {
        if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
        const payloadText = (line.startsWith('data:') ? line.slice(5) : line).trim();
        if (!payloadText || payloadText === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue;
        }
        const token = extractToken(request.provider, payload);
        // reasoning-дельты — тоже активность модели, не даём first-token таймауту сработать.
        const choiceForReasoning = payload.choices && payload.choices[0];
        const reasoning =
          choiceForReasoning && choiceForReasoning.delta && typeof choiceForReasoning.delta.reasoning_content === 'string'
            ? choiceForReasoning.delta.reasoning_content
            : '';
        if ((token || reasoning) && !firstTokenSeen) {
          firstTokenSeen = true;
          firstTokenTimer && clearTimeout(firstTokenTimer);
        }
        if (token) {
          full += token;
          yield { type: 'token', text: token };
        }
        if (request.provider === 'ollama' && payload.done === true) doneSeen = true;
        if (request.provider === 'anthropic' && payload.type === 'message_stop') doneSeen = true;
        if (request.provider !== 'anthropic' && request.provider !== 'ollama') {
          const choice = payload.choices && payload.choices[0];
          if (choice && choice.finish_reason) doneSeen = true;
        }
      }
      if (!full.trim()) {
        throw new LLMError('BAD_RESPONSE', 'Модель вернула пустой ответ. Повторите запрос.', { retryable: false });
      }
      yield { type: 'done', text: full, stopReason: doneSeen ? 'stop' : 'eof' };
      return;
    } catch (error) {
      if (error instanceof LLMError && error.code === 'BAD_RESPONSE' && !error.retryable) throw error;
      if (userAborted) throw new LLMError('ABORTED', 'Остановлено');
      if (timedOut) {
        throw new LLMError('TIMEOUT', 'Провайдер не ответил вовремя.', {
          hint: 'Проверьте соединение и повторите запрос.',
        });
      }
      if (error instanceof LLMError && error.code === 'PROVIDER') throw error;
      const mapped = error instanceof LLMError ? error : networkError(error);
      // DeepSeek может отклонить thinking/reasoning_effort — один повтор без них и без temperature.
      // Только если текст ошибки действительно про эти поля, а не «invalid model»/битый запрос.
      const providerErrorText = `${mapped.message || ''} ${mapped.hint || ''}`;
      const thinkingRejected = /unknown field|unrecognized|unexpected|unsupported|thinking|reasoning_effort/i.test(providerErrorText);
      if (
        mapped.code === 'BAD_REQUEST' &&
        request.provider === 'deepseek' &&
        !fallbackTried &&
        thinkingRejected &&
        request.body &&
        (request.body.thinking || request.body.reasoning_effort)
      ) {
        fallbackTried = true;
        const fallbackBody = { ...request.body };
        delete fallbackBody.thinking;
        delete fallbackBody.reasoning_effort;
        delete fallbackBody.temperature;
        request = { ...request, body: fallbackBody };
        yield {
          type: 'notice',
          text: 'Провайдер не принял thinking/reasoning_effort — повторяю без них (temperature не отправляется).',
        };
        continue;
      }
      const canRetry = mapped.retryable && !firstTokenSeen && attempt < LIMITS.maxRetries;
      if (canRetry) {
        attempt += 1;
        try {
          await delay(600 * 2 ** (attempt - 1), signal);
        } catch {
          throw new LLMError('ABORTED', 'Остановлено');
        }
        continue;
      }
      throw mapped;
    } finally {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (signal) signal.removeEventListener('abort', abortFromUser);
    }
  }
}

/* ------------------------------------------------------------------ */
/* connection test                                                     */
/* ------------------------------------------------------------------ */

async function timedFetch(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, credentials: 'omit', cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверка соединения без генерации контента (почти).
 * @returns {Promise<{ok:boolean, message:string, hint?:string, latencyMs:number, models?:string[], endpoint?:string, code?:string}>}
 */
export async function testConnection({ settings }) {
  const s = normalizeSettings(settings);
  const started = Date.now();
  const latency = () => Date.now() - started;
  const root = apiRoot(s);
  if (!root) {
    return { ok: false, message: 'Некорректный адрес API.', hint: 'Проверьте настройки расширения.', latencyMs: 0, code: 'BAD_CONFIG' };
  }
  if (isDemoMode(s)) {
    return {
      ok: false,
      message: 'Ключ не задан — активен демо-режим.',
      hint: 'Вставьте API-ключ DeepSeek в настройках расширения.',
      latencyMs: 0,
      code: 'NO_KEY',
    };
  }

  if (s.provider === 'ollama') {
    try {
      const response = await timedFetch(`${root}/api/tags`, { method: 'GET' });
      if (!response.ok) {
        const mapped = mapHttpError(response.status, await response.text());
        return { ok: false, message: mapped.message, hint: mapped.hint, latencyMs: latency(), endpoint: `${root}/api/tags`, code: mapped.code };
      }
      const data = await response.json();
      const models = Array.isArray(data.models) ? data.models.map((m) => m && m.name).filter(Boolean) : [];
      return {
        ok: true,
        message: 'Ollama отвечает.',
        hint: models.includes(s.model) ? '' : `Модели «${s.model}» в списке нет — проверьте имя (ollama pull ${s.model}).`,
        latencyMs: latency(),
        endpoint: `${root}/api/tags`,
      };
    } catch (error) {
      return {
        ok: false,
        message: 'Ollama недоступна.',
        hint: `Запустите «ollama serve» и разрешите расширению доступ к ${root}. Детали: ${error && error.message ? error.message : 'сеть'}`,
        latencyMs: latency(),
        code: 'NETWORK',
      };
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (s.provider === 'anthropic') {
    headers['x-api-key'] = s.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers.Authorization = `Bearer ${s.apiKey}`;
  }

  // 1) Пытаемся получить список моделей (дешёвый и информативный вызов).
  try {
    const response = await timedFetch(`${root}/models`, { method: 'GET', headers });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models = raw.map((m) => (m && (m.id || m.name)) || '').filter(Boolean);
      const known = models.some((id) => id === s.model || id.endsWith(`/${s.model}`));
      if (models.length && !known) {
        // Не даём ложный зелёный статус: генерация с этой моделью не заработает.
        return {
          ok: false,
          message: `Соединение есть, но модель «${s.model}» недоступна провайдеру.`,
          hint: 'Проверьте модель/доступ ключа; иначе генерация будет падать.',
          latencyMs: latency(),
          endpoint: `${root}/models`,
          code: 'MODEL_NOT_FOUND',
        };
      }
      return {
        ok: true,
        message: 'Соединение работает.',
        hint: known ? '' : 'Список моделей пуст — проверка только по соединению.',
        latencyMs: latency(),
        endpoint: `${root}/models`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      const mapped = mapHttpError(response.status, await response.text());
      return { ok: false, message: mapped.message, hint: mapped.hint, latencyMs: latency(), endpoint: `${root}/models`, code: mapped.code };
    }
    // /models может не поддерживаться (Ollama-совместимые, прокси) — пробуем минимальный запрос.
  } catch (error) {
    // Ничего: ниже попробуем chat-запрос, чтобы отличить DNS-ошибку от отсутствия /models.
  }

  // 2) Минимальный запрос генерации.
  try {
    const probeHeaders = { ...headers };
    const body =
      s.provider === 'anthropic'
        ? { model: s.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
        : { model: s.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }], stream: false };
    const response = await timedFetch(chatEndpoint(s), {
      method: 'POST',
      headers: probeHeaders,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const mapped = mapHttpError(response.status, await response.text());
      return { ok: false, message: mapped.message, hint: mapped.hint, latencyMs: latency(), endpoint: chatEndpoint(s), code: mapped.code };
    }
    return {
      ok: true,
      message: 'Соединение работает (проверено минимальным запросом).',
      hint: '',
      latencyMs: latency(),
      endpoint: chatEndpoint(s),
    };
  } catch (error) {
    const mapped = networkError(error);
    return {
      ok: false,
      message: mapped.message,
      hint: mapped.hint,
      latencyMs: latency(),
      endpoint: chatEndpoint(s),
      code: mapped.code,
    };
  }
}

/** Удобное представление ошибки для UI. */
export function describeLLMError(error) {
  if (error instanceof LLMError) {
    return { code: error.code, title: error.message, hint: error.hint, retryable: error.retryable, status: error.status };
  }
  return {
    code: 'UNKNOWN',
    title: 'Неожиданная ошибка.',
    hint: error && error.message ? String(error.message) : 'Подробностей нет.',
    retryable: false,
    status: 0,
  };
}
