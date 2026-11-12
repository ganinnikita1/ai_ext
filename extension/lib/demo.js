/**
 * lib/demo.js — детерминированный «демо-режим» без сети.
 *
 * Нужен, чтобы расширение можно было показать/протестировать без ключа:
 * ответы строятся локально из реального контекста (страница/письмо),
 * выглядят правдоподобно и честно помечены как демонстрационные.
 * Никаких сетевых вызовов здесь нет.
 */

import { isDemoMode } from './config.js';

export function demoAvailable(settings) {
  return isDemoMode(settings);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function firstSentences(text, count = 2, maxChars = 320) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const parts = clean.match(/[^.!?…]+[.!?…]+/g);
  const picked = (parts ? parts.slice(0, count) : [clean]).join(' ').trim();
  return picked.length > maxChars ? `${picked.slice(0, maxChars).trim()}…` : picked;
}

function cleanSubject(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function displayName(value) {
  const withoutEmail = cleanSubject(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return withoutEmail || 'коллега';
}

function replyVariants(mail) {
  const m = mail || {};
  const subject = cleanSubject(m.subject) || 'по вашему письму';
  const messages = Array.isArray(m.messages) ? m.messages : [];
  const last = messages[messages.length - 1] || {};
  const from = displayName(last.from);
  const lastLine = firstSentences(last.text, 1, 160);
  const topic = lastLine ? `По сути вопроса: «${lastLine}»` : 'По вашему вопросу';
  return [
    {
      index: 1,
      number: 1,
      tone: 'формальный',
      text: [
        `Здравствуйте, ${from}!`,
        '',
        `Спасибо за письмо по теме «${subject}». ${topic}`,
        'Готов(а) обсудить детали и предложить решение. Подскажите, пожалуйста, удобный срок для ответа и приоритет задачи — подготовлю уточнённый план.',
        '',
        'С уважением,',
      ].join('\n'),
    },
    {
      index: 2,
      number: 2,
      tone: 'нейтральный',
      text: [
        `Привет, ${from}!`,
        '',
        `Понял(а) задачу по письму «${subject}». ${lastLine ? `Ключевой момент: «${lastLine}».` : ''}`,
        'Сейчас соберу информацию и вернусь с ответом. Если есть жёсткий дедлайн — напишите, подстроюсь.',
        '',
        'Спасибо!',
      ].join('\n'),
    },
    {
      index: 3,
      number: 3,
      tone: 'краткий',
      text: [
        `Спасибо, ${from}!`,
        '',
        `Принял(а) в работу: ${subject}.`,
        'Вернусь с ответом в ближайшее время. Если срочно — позвоните.',
        '',
        'С уважением,',
      ].join('\n'),
    },
  ];
}

function formatVariants(variants) {
  return variants
    .map((v) => `### ВАРИАНТ ${v.number} — ${v.tone}\n${v.text}`)
    .join('\n');
}

function explainText(page, question) {
  const p = page || {};
  const title = cleanSubject(p.title) || 'страница без заголовка';
  const summary = firstSentences(p.text, 2) || 'Текст страницы извлечь не удалось.';
  const headings = Array.isArray(p.headings) ? p.headings.filter(Boolean).slice(0, 5) : [];
  const lines = [];
  if (question) {
    lines.push(`Вопрос: «${String(question).slice(0, 300)}»`);
    lines.push('');
    lines.push('Короткий разбор по странице:');
  } else {
    lines.push(`О чём страница: «${title}». ${summary}`);
    lines.push('');
    lines.push('Ключевые тезисы:');
  }
  if (headings.length) {
    headings.forEach((h, i) => lines.push(`${i + 1}. ${h.slice(0, 140)}`));
  } else {
    lines.push('1. Структурированные заголовки на странице не найдены.');
    lines.push('2. Основной текст извлечён эвристически — проверьте ключевые утверждения вручную.');
  }
  lines.push('');
  lines.push('На что обратить внимание:');
  lines.push('- Источник и дата публикации не определяются автоматически — уточните, актуальна ли информация.');
  lines.push('- Для точного ответа по цифрам и срокам лучше открыть первоисточник.');
  lines.push('');
  lines.push('Чего не хватает: полного текста (часть страницы могла быть скрыта) и контекста вопроса.');
  return lines.join('\n');
}

function summaryText(mail) {
  const m = mail || {};
  const messages = Array.isArray(m.messages) ? m.messages : [];
  const last = messages[messages.length - 1] || {};
  const subject = cleanSubject(m.subject) || 'без темы';
  const lines = [];
  lines.push(`Переписка: «${subject}» (сообщений извлечено: ${messages.length}).`);
  lines.push('');
  lines.push('Суть:');
  lines.push(`- ${firstSentences(last.text, 2) || 'Основной текст письма не извлечён.'}`);
  lines.push('');
  lines.push('Что от вас хотят:');
  lines.push(`- ${messages.length ? 'Ответ на последнее сообщение от ' + (cleanSubject(last.from) || 'отправителя') + '.' : 'Определить не удалось.'}`);
  lines.push('');
  lines.push('Сроки и договорённости:');
  lines.push('- Явно не указаны (или не распознаны) — уточните у отправителя.');
  lines.push('');
  lines.push('Действия:');
  lines.push('1. Ответить на последнее сообщение.');
  lines.push('2. Проверить вложения и ссылки вручную.');
  lines.push('3. Уточнить недостающие сроки/суммы.');
  return lines.join('\n');
}

function chatText(demo) {
  const question = cleanSubject(demo && demo.question);
  const context = demo && demo.context;
  const lines = [];
  lines.push(`Вопрос: «${question || 'без текста'}»`);
  lines.push('');
  if (context && context.kind === 'page' && context.page) {
    lines.push(`Контекст — страница «${cleanSubject(context.page.title) || 'без заголовка'}».`);
    lines.push(firstSentences(context.page.text, 2) || 'Текст страницы пуст.');
  } else if (context && context.kind === 'mail' && context.mail) {
    lines.push(`Контекст — письмо «${cleanSubject(context.mail.subject) || 'без темы'}».`);
    const msgs = Array.isArray(context.mail.messages) ? context.mail.messages : [];
    lines.push(firstSentences(msgs[msgs.length - 1] && msgs[msgs.length - 1].text, 2) || 'Текст письма пуст.');
  } else if (context && context.kind === 'selection' && context.text) {
    lines.push('Контекст — выделенный фрагмент:');
    lines.push(firstSentences(context.text, 2) || '(пусто)');
  } else {
    lines.push('Контекст не приложен.');
  }
  lines.push('');
  lines.push('Это демонстрационный ответ: без ключа модель не вызывается. Подключите провайдера в настройках, чтобы получить настоящий разбор.');
  return lines.join('\n');
}

function buildText(demo) {
  const d = demo || {};
  if (d.kind === 'reply') return formatVariants(replyVariants(d.mail));
  if (d.kind === 'summary') return summaryText(d.mail);
  if (d.kind === 'explain' || d.kind === 'page_question') return explainText(d.page, d.question);
  if (d.kind === 'chat') return chatText(d);
  return 'Демо-ответ: подключите провайдера в настройках, чтобы получить ответ модели.';
}

/**
 * Стримит демо-ответ теми же событиями, что и настоящий клиент.
 * @param {{task:object, signal?:AbortSignal, delayMs?:number}} options
 */
export async function* demoStream({ task, signal, delayMs = 16 }) {
  // Дисклеймер демо — отдельное UI-notice, а не часть варианта/письма.
  const text = buildText(task && task.demo);
  const tokens = text.match(/\s*\S+/g) || [text];
  for (const token of tokens) {
    if (signal && signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    yield { type: 'token', text: token };
    await sleep(delayMs, signal);
  }
  yield { type: 'done', text };
}
