/**
 * content.js — контент-скрипт «AI Bro» (classic script, без ES-модулей).
 *
 * Что делает:
 *  - эвристически извлекает основной текст страницы (Readability-like, без библиотек);
 *  - на Gmail и Outlook Web читает открытый тред (best-effort, вёрстка меняется);
 *  - вставляет предложенный текст в композер (несколько стратегий, понятная деградация);
 *  - показывает плавающую кнопку на страницах почты;
 *  - отдаёт выделенный текст и текст композера по запросу side panel.
 *
 * БЕЗОПАСНОСТЬ:
 *  - скрипт только ЧИТАЕТ DOM и по явному запросу вставляет текст;
 *  - он никогда не отправляет письма и не нажимает кнопки;
 *  - содержимое страницы не исполняется и не вставляется как HTML.
 */

(() => {
  'use strict';

  if (window.__AI_COPILOT_CONTENT__) return;
  window.__AI_COPILOT_CONTENT__ = true;

  const VERSION = '0.2.16';
  const LIMITS = { pageChars: 14000, mailChars: 12000, selectionChars: 4000, comptoserChars: 6000, walkBudget: 20000 };

  const NOISE_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'nav', 'footer', 'aside', 'form', 'button', 'select', 'textarea', 'input', 'label',
    'video', 'audio', 'header', 'menu', 'dialog', 'figure',
  ]);

  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'li', 'ul', 'ol',
    'pre', 'blockquote', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figcaption', 'dd', 'dt', 'dl', 'html', 'body',
  ]);

  const NOISE_CLASS = /cookie|consent|gdpr|advert|newsletter|popup|modal|subscribe|social-share|share-buttons|related-|recommend|breadcrumb|pagination|comments?-|sidebar|navbar|navigation|skip-link/i;
  const QUOTE_SELECTORS = '.gmail_quote, blockquote, .gmail_signature, .gmail_attr, .yahoo_quoted, .moz-cite-prefix, [class*="quote"]';

  /* ------------------------------------------------------------------ */
  /* utils                                                              */
  /* ------------------------------------------------------------------ */

  function text(value) {
    return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function metaContent(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? text(el.getAttribute('content')) : '';
  }

  function countWords(value) {
    const matches = String(value || '').match(/[A-Za-zА-Яа-яЁё0-9]{2,}/g);
    return matches ? matches.length : 0;
  }

  function makeVisibilityCache() {
    const cache = new WeakMap();
    return function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      if (cache.has(el)) return cache.get(el);
      let result = true;
      try {
        if (el.closest('[hidden], [aria-hidden="true"]')) result = false;
        if (result) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') result = false;
        }
        if (result) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) result = false;
        }
      } catch {
        result = false;
      }
      cache.set(el, result);
      return result;
    };
  }

  /* ------------------------------------------------------------------ */
  /* site detection                                                     */
  /* ------------------------------------------------------------------ */

  // mail.yandex.* — потребительская почта, mail.360.yandex.* — Яндекс 360 (классический BEM-UI).
  const YANDEX_MAIL_RE = /^(?:mail\.yandex|mail\.360\.yandex)\.(?:ru|com|by|kz|com\.tr|az|co\.il|ua)$/;

  function detectSite() {
    const host = location.hostname;
    if (host === 'mail.google.com') return 'gmail';
    if (/^outlook\.(office|office365|live)\.com$/.test(host)) return 'outlook';
    if (YANDEX_MAIL_RE.test(host)) return 'yandex';
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* open message / thread: только область чтения                        */
  /* ------------------------------------------------------------------ */

  let mailChangeTimer = null;
  let lastMailSignature = '';

  /**
   * openIndex — развёрнутое/открытое сообщение, иначе самое свежее (последнее)
   * из видимых в reading pane. Никаких кликов/фокуса/picker.
   */
  function finalizeOpen(messages, nodes) {
    const threadMessages = messages.slice(-6);
    const offset = Math.max(0, messages.length - threadMessages.length);
    let openIndex = -1;
      for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const node = nodes[offset + index];
      if (!node || node.nodeType !== 1) continue;
      const expanded = node.getAttribute('aria-expanded') === 'true';
      const className = typeof node.className === 'string' ? node.className : '';
      if (
        expanded ||
        node.getAttribute('aria-current') === 'true' ||
        /(?:^|[-_])(?:expanded|open|selected|active|current)(?:$|[-_])/i.test(className)
      ) {
        openIndex = index;
        break;
      }
    }
    if (openIndex < 0) openIndex = threadMessages.length - 1;
    openIndex = Math.max(0, Math.min(threadMessages.length - 1, openIndex));
    return {
      threadMessages,
      openIndex,
      openMessage: threadMessages[openIndex] || null,
    };
  }

  function isMailMutation(records) {
    const site = detectSite();
    if (!site) return false;
    for (const record of records) {
      const target = record.target && record.target.nodeType === 1 ? record.target : record.target && record.target.parentElement;
      if (!target || typeof target.closest !== 'function') continue;
      if (target.closest('[contenteditable="true"], .mail-Compose-Body')) continue;
      if (site === 'yandex' && target.closest(YANDEX_SIDEBAR_SELECTOR)) continue;
      // Мутации внутри reading pane / карточек в main, без сайдбаров.
      if (target.closest('[role="main"], main, .mail-MessageView, .mail-Thread, [data-message-id], [role="article"]')) return true;
    }
    return false;
  }

  function scheduleMailChangePush() {
    if (!detectSite()) return;
    clearTimeout(mailChangeTimer);
    // 1.5 с: DOM почты меняется часто (счётчики/hover), полный extract — дорогой.
    mailChangeTimer = setTimeout(pushMailContextChanged, 1500);
  }

  /** Сообщить side panel об изменении письма/фокуса (только при реальном изменении). */
  function pushMailContextChanged() {
    if (!detectSite()) return;
    let mail = null;
    try {
      mail = extractMailContext();
    } catch {
      return;
    }
    if (!mail || !Array.isArray(mail.messages) || !mail.messages.length) return;
    const open = mail.openMessage || {};
    const signature = [
      mail.subject,
      mail.messages.length,
      open.from,
      open.time,
      (mail.participants || []).join('|'),
    ].join('::');
    if (signature === lastMailSignature) return;
    lastMailSignature = signature;
    try {
      const promise = chrome.runtime.sendMessage({ type: 'MAIL_CONTEXT_CHANGED', site: detectSite(), mail, ts: Date.now() });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {
      /* панель закрыта */
    }
  }

  /* ------------------------------------------------------------------ */
  /* generic text extraction                                            */
  /* ------------------------------------------------------------------ */

  function isNoiseElement(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute('hidden')) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.getAttribute('role') === 'navigation') return true;
    if (node.getAttribute('role') === 'banner') return true;
    if (node.getAttribute('role') === 'complementary') return true;
    if (node.getAttribute('role') === 'dialog') return true;
    const style = node.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls && NOISE_CLASS.test(cls)) return true;
    return false;
  }

  function nodeToText(root) {
    let out = '';
    let budget = LIMITS.walkBudget;
    const walk = (node) => {
      if (!node || budget <= 0) return;
      budget -= 1;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (NOISE_TAGS.has(tag)) return;
      if (isNoiseElement(node)) return;
      if (tag === 'br') {
        out += '\n';
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out += '\n';
      if (tag === 'li') out += '- ';
      for (const child of node.childNodes) walk(child);
      if (block) out += '\n';
    };
    walk(root);
    return normalizeText(out);
  }

  function pickContentContainer(isVisible) {
    const blocks = document.querySelectorAll('p, pre, blockquote, li, td, h2, h3');
    const scores = new Map();
    let considered = 0;
    for (const block of blocks) {
      if (considered > 4000) break;
      considered += 1;
      if (!isVisible(block)) continue;
      const value = (block.innerText || block.textContent || '').trim();
      if (value.length < 30) continue;
      const commas = (value.match(/[,;:]/g) || []).length;
      const linkText = Array.from(block.querySelectorAll('a')).reduce((sum, a) => sum + (a.innerText || '').length, 0);
      const linkDensity = value.length ? linkText / value.length : 0;
      if (linkDensity > 0.6) continue;
      let score = 1 + Math.min(value.length / 100, 4) + commas * 0.3;
      if (linkDensity > 0.3) score *= 0.5;
      let node = block.parentElement;
      for (let level = 0; node && level < 4; level += 1) {
        const current = scores.get(node) || 0;
        scores.set(node, current + score / (level === 0 ? 1 : level * 2));
        node = node.parentElement;
      }
    }
    if (!scores.size) return null;
    const ranked = [...scores.entries()]
      .filter(([el]) => el && el !== document.body && el !== document.documentElement)
      .sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [best, bestScore] = ranked[0];
    if (bestScore < 3) return null;
    // Предпочитаем article/main, если он рядом по счёту.
    const article = best.closest('article, main, [role="main"]');
    if (article && isVisible(article) && (article.innerText || '').length >= 200) return article;
    return best;
  }

  function collectHeadings() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('h1, h2, h3')) {
      const value = text(el.innerText || el.textContent);
      if (!value || value.length < 3 || value.length > 160) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= 10) break;
    }
    return out;
  }

  function extractMainContent() {
    const started = Date.now();
    const isVisible = makeVisibilityCache();
    const container = pickContentContainer(isVisible);
    let bodyText = '';
    if (container) bodyText = nodeToText(container);
    if (bodyText.length < 300) {
      bodyText = normalizeText(document.body ? document.body.innerText : '');
    }
    const fullLength = bodyText.length;
    const truncated = fullLength > LIMITS.pageChars;
    if (truncated) bodyText = bodyText.slice(0, LIMITS.pageChars);
    return {
      title: text(document.title),
      url: location.href,
      siteName: metaContent('og:site_name') || location.hostname,
      description: metaContent('description') || metaContent('og:description'),
      lang: document.documentElement.lang || '',
      headings: collectHeadings(),
      text: bodyText,
      truncated,
      wordCount: countWords(bodyText),
      extractionMs: Date.now() - started,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Gmail                                                              */
  /* ------------------------------------------------------------------ */

  const ATTACHMENT_CONTAINER_SELECTORS = [
    '.mail-Message-Attachments',
    '[class*="Attachment" i]',
    '[class*="attach" i]',
    '[class*="file" i]',
    '[data-automationid*="attachment" i]',
    '[data-testid*="attachment" i]',
    '.aZo',
    '[download_url]',
  ];

  const ATTACHMENT_EXT_RE = /\.(xlsx?|xlsm|csv|pdf|docx?|pptx?|txt|rtf|odt|ods|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|avi|mkv|mp3|wav|ogg|eml|msg|json|xml)\b/i;

  function filenameFromValue(value) {
    const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 220) return '';
    const withoutSize = raw.replace(/\s+\d+(?:[.,]\d+)?\s*(?:Б|КБ|МБ|ГБ|KB|MB|GB)\s*$/i, '').trim();
    // Плашка целиком — «ЗАКАЗЫ НА 06.11.26.xls» (имя может содержать пробелы).
    const whole = withoutSize.match(
      /^[«"']?(.+?\.(?:xlsx?|xlsm|csv|pdf|docx?|pptx?|txt|rtf|odt|ods|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|avi|mkv|mp3|wav|ogg|eml|msg|json|xml))[»"']?$/i,
    );
    if (whole) {
      const name = whole[1].trim();
      return name.split(/\s+/).length <= 6 ? name : '';
    }
    const match = withoutSize.match(
      /([^\s,;:«»"'<>|/\\*?]+(?:\s+[^\s,;:«»"'<>|/\\*?]+){0,3}\.(?:xlsx?|xlsm|csv|pdf|docx?|pptx?|txt|rtf|odt|ods|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|avi|mkv|mp3|wav|ogg|eml|msg|json|xml))\b/i,
    );
    if (!match) return '';
    const before = withoutSize.slice(0, match.index).trim();
    // «Во вложении ЗАКАЗЫ.xls ...» — это предложение, а не плашка с файлом.
    if (before && before.split(/\s+/).length > 4) return '';
    return match[1].trim();
  }

  /** Имена вложений в карточке письма (без путей/размеров), дедуп, до 10 штук. */
  function extractAttachments(root, site) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const names = new Set();
    const add = (value) => {
      const name = filenameFromValue(value);
      if (name) names.add(name);
    };
    const addFromElement = (element, includeHref) => {
      if (!element || typeof element.getAttribute !== 'function') return;
      add(element.getAttribute('title'));
      add(element.getAttribute('aria-label'));
      add(element.getAttribute('download'));
      add(element.getAttribute('download_url'));
      if (includeHref && !names.size) {
        const href = element.getAttribute('href');
        if (href) add(href.split('?')[0].split('/').pop());
      }
    };
    const containers = [];
    for (const selector of ATTACHMENT_CONTAINER_SELECTORS) {
      let found;
      try {
        found = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of found) containers.push(node);
    }
    for (const container of containers) {
      addFromElement(container, false);
      add(container.textContent);
      for (const child of container.querySelectorAll('[title], [aria-label], [download], [download_url], a[href]')) {
        addFromElement(child, false);
      }
    }
    if (!names.size) {
      // Generic fallback: атрибуты/href, чтобы не ловить фразы из тела письма.
      for (const element of root.querySelectorAll('[title], [aria-label], [download], [download_url], a[href]')) {
        addFromElement(element, true);
      }
    }
    return [...names].slice(0, 10);
  }

  /** Вложения только текущей карточки: не тащим плашки из вложенных/цитируемых писем. */
  function extractYandexAttachments(node) {
    if (!node || typeof node.cloneNode !== 'function') return [];
    const clone = node.cloneNode(true);
    for (const nested of clone.querySelectorAll('.mail-Message, .mail-Thread-Message')) nested.remove();
    return extractAttachments(clone, 'yandex');
  }

  function cleanMailBody(element, extraNoise = '') {
    try {
      const clone = element.cloneNode(true);
      const noiseSelector = extraNoise ? `${QUOTE_SELECTORS}, ${extraNoise}` : QUOTE_SELECTORS;
      for (const noise of clone.querySelectorAll(noiseSelector)) noise.remove();
      for (const img of clone.querySelectorAll('img')) {
        if (img.alt) img.replaceWith(document.createTextNode(` [${img.alt}] `));
        else img.remove();
      }
      let value = nodeToText(clone);
      value = value
        .split('\n')
        .filter((line) => !/^\s*>/.test(line))
        .join('\n');
      return normalizeText(value).slice(0, LIMITS.mailChars);
    } catch {
      return '';
    }
  }

  function gmailTimestamp(node) {
    const el = node.querySelector('.g3, [title], .g2');
    if (!el) return '';
    const title = el.getAttribute('title');
    return text(title || el.innerText || el.textContent);
  }

  function extractGmailThread() {
    const main = document.querySelector('div[role="main"]');
    if (!main) return null;
    let subject = '';
    const subjectEl = main.querySelector('h2.hP, h2[data-thread-perm-id], h2');
    if (subjectEl) subject = text(subjectEl.innerText || subjectEl.textContent);
    if (!subject) subject = text(document.title).replace(/\s*[-–—]\s*Gmail\s*$/i, '');

    let cards = Array.from(main.querySelectorAll('div.adn.ads'));
    if (!cards.length) {
      cards = Array.from(main.querySelectorAll('.a3s')).map((body) => body.closest('div.adn, div[data-message-id], div[role="listitem"]') || body.parentElement);
    }
    cards = cards.filter(Boolean);
    const messages = [];
    const keptCards = [];
    const participants = [];
    for (const card of cards) {
      const attachments = extractAttachments(card, 'gmail');
      const bodyEl = card.querySelector('.a3s.aiL, .a3s');
      if (!bodyEl && !attachments.length) continue;
      const fromEl = card.querySelector('.gD, [email]');
      const from = fromEl ? text(fromEl.getAttribute('email') || fromEl.innerText || fromEl.textContent) : '';
      const body = bodyEl ? cleanMailBody(bodyEl) : '';
      if (!body && !attachments.length) continue;
      messages.push({ from, time: gmailTimestamp(card), text: body || '(без текста)', attachments });
      keptCards.push(card);
      if (from) participants.push(from);
    }
    let degraded = false;
    if (!messages.length) {
      degraded = true;
      // Не отдаём весь UI: только сообщение/тело внутри reading pane.
      const fallbackRoot = main.querySelector('[data-message-id], .a3s, .adn.ads');
      if (!fallbackRoot) return null;
      const fallbackText = normalizeText(nodeToText(fallbackRoot)).slice(0, LIMITS.mailChars);
      if (!fallbackText) return null;
      const fallbackMessage = { from: '', time: '', text: fallbackText, attachments: extractAttachments(fallbackRoot, 'gmail') };
      return {
        site: 'gmail',
        subject,
        participants: [],
        messages: [fallbackMessage],
        threadMessages: [fallbackMessage],
        openMessage: fallbackMessage,
        openIndex: 0,
        degraded,
        url: location.href,
      };
    }
    const finalized = finalizeOpen(messages, keptCards);
    return {
      site: 'gmail',
      subject,
      participants: [...new Set(participants)].slice(0, 10),
      messages: finalized.threadMessages,
      threadMessages: finalized.threadMessages,
      openMessage: finalized.openMessage,
      openIndex: finalized.openIndex,
      degraded,
      url: location.href,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Outlook Web                                                        */
  /* ------------------------------------------------------------------ */

  const OUTLOOK_BODY_SELECTORS = [
    'div[id^="UniqueMessageBody"]',
    '[data-automationid="messageBody"]',
    '[data-app-section="MessageBody"]',
    'div.allowTextSelection',
    'div[class*="allowTextSelection"]',
    'div[aria-label="Message body"]',
  ];

  const OUTLOOK_CARD_SELECTOR = [
    'div[role="listitem"]',
    '[data-automationid="MessageCard"]',
    '[data-convid]',
    '[data-app-section="ConversationContainer"] > div',
  ].join(', ');

  function findOutlookBodies(main) {
    for (const selector of OUTLOOK_BODY_SELECTORS) {
      let nodes = Array.from(main.querySelectorAll(selector));
      if (!nodes.length) continue;
      nodes = nodes.filter((node) => node.offsetWidth > 0 || node.offsetHeight > 0);
      if (!nodes.length) continue;
      // Убираем вложенные дубликаты (внешний и внутренний контейнеры).
      nodes = nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
      return { nodes, selector };
    }
    return { nodes: [], selector: '' };
  }

  function outlookSender(card) {
    if (!card) return '';
    const candidates = [
      '[data-automationid="messageSender"]',
      '[title*="@"]',
      'a[href^="mailto:"]',
      '.ms-Persona-primaryText',
      '[class*="persona"] [title]',
    ];
    for (const selector of candidates) {
      const el = card.querySelector(selector);
      if (!el) continue;
      const value = text(el.getAttribute('title') || el.innerText || el.textContent);
      if (value) return value;
    }
    const mailto = card.querySelector('a[href^="mailto:"]');
    if (mailto) return text(mailto.getAttribute('href').replace(/^mailto:/i, ''));
    return '';
  }

  function outlookTimestamp(card) {
    if (!card) return '';
    const candidates = ['[data-automationid="messageTimestamp"]', 'time', '[title*=":"]'];
    for (const selector of candidates) {
      const el = card.querySelector(selector);
      if (!el) continue;
      const value = text(el.getAttribute('title') || el.innerText || el.textContent);
      if (value && value.length < 80) return value;
    }
    return '';
  }

  function extractOutlookThread() {
    const main = document.querySelector('[role="main"]') || document.querySelector('div[class*="ReadingPane"]');
    if (!main) return null;
    let subject = '';
    for (const heading of main.querySelectorAll('[role="heading"], h1, h2')) {
      const value = text(heading.innerText || heading.textContent);
      if (value && value.length > 2 && !/^(inbox|входящие|outlook)$/i.test(value)) {
        subject = value;
        break;
      }
    }
    if (!subject) subject = text(document.title).split(' - ')[0];

    const found = findOutlookBodies(main);
    let degraded = false;
    const entries = [];
    const entryCards = [];

    if (found.nodes.length) {
      for (const bodyEl of found.nodes) {
        const card = bodyEl.closest(OUTLOOK_CARD_SELECTOR) || bodyEl.parentElement;
        const attachments = extractAttachments(card || bodyEl, 'outlook');
        const bodyText = cleanMailBody(bodyEl);
        if (!bodyText && !attachments.length) continue;
        entries.push({ from: outlookSender(card), time: outlookTimestamp(card), text: bodyText || '(без текста)', attachments });
        entryCards.push(card || bodyEl);
      }
    }

    if (!entries.length) {
      // Вёрстка не распознана — отдаём весь регион чтения как одно сообщение.
      degraded = true;
      const paneText = normalizeText(nodeToText(main)).slice(0, LIMITS.mailChars);
      if (!paneText) return null;
      const fromGuess = (() => {
        const mailto = main.querySelector('a[href^="mailto:"]');
        if (mailto) return text(mailto.getAttribute('href').replace(/^mailto:/i, ''));
        const withEmail = Array.from(main.querySelectorAll('[title*="@"], [aria-label*="@"]'))
          .map((el) => text(el.getAttribute('title') || el.getAttribute('aria-label')))
          .find((value) => /@/.test(value));
        return withEmail || '';
      })();
      entries.push({ from: fromGuess, time: '', text: paneText, attachments: extractAttachments(main, 'outlook') });
      entryCards.push(main);
    }

    const finalized = finalizeOpen(entries, entryCards);
    const participants = entries.map((e) => e.from).filter(Boolean);
    return {
      site: 'outlook',
      subject,
      participants: [...new Set(participants)].slice(0, 10),
      messages: finalized.threadMessages,
      threadMessages: finalized.threadMessages,
      openMessage: finalized.openMessage,
      openIndex: finalized.openIndex,
      degraded,
      url: location.href,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Яндекс Почта / Яндекс 360 (best-effort: BEM + React, CSS-модули)   */
  /* ------------------------------------------------------------------ */

  const YANDEX_SUBJECT_SELECTORS = [
    // Классический BEM-UI Яндекс 360 / Яндекс Почты
    '.mail-Thread-Subject',
    '.mail-Message-Subject',
    '.mail-Thread-Header-Topic',
    '.mail-Thread-Header-Subject',
    '[data-testid*="subject" i]',
    '[data-testid*="Subject" i]',
    '[class*="subject" i]',
    '[class*="Subject" i]',
    'h1',
    'h2',
  ];

  const YANDEX_MESSAGE_SELECTORS = [
    // BEM-карточка письма. ВАЖНО: .mail-MessageSnippet — сниппет списка писем, его не берём.
    '.mail-Message',
    '.mail-Thread-Message',
    '[data-testid*="letter" i]',
    '[data-testid*="message" i]',
    '[data-testid*="thread" i]',
    '[class*="letter" i]',
    '[class*="message" i]',
    '[class*="thread" i]',
  ];

  // Область чтения открытого письма (не список/не сайдбар).
  const YANDEX_READING_PANE_SELECTORS = [
    '.mail-MessageView',
    '.mail-Message-View',
    '.mail-Thread',
    '.mail-Content',
    '.mail-App-Content',
    '[data-testid*="message-view" i]',
    '[data-testid*="messageview" i]',
    '[data-testid*="thread" i]',
  ];

  // Сайдбары/списки писем/сниппеты: их карточки — не сообщения треда.
  const YANDEX_SIDEBAR_SELECTOR = [
    '[class*="ThreadsList" i]',
    '[class*="ThreadList" i]',
    '[class*="thread-list" i]',
    '[class*="MessageList" i]',
    '[class*="Snippet" i]',
    '[class*="Sidebar" i]',
    '[role="complementary"]',
    '[class*="letters" i]',
    '[class*="LettersList" i]',
    '[class*="related" i]',
    '[class*="Related" i]',
    '[class*="similar" i]',
    '[class*="Similar" i]',
    '[data-testid*="related" i]',
  ].join(', ');

  const YANDEX_SENDER_SELECTORS = [
    '.mail-Message-Sender',
    '.mail-Message-Header-Sender',
    '.mail-Message-From',
    '.mail-Message-Header-From',
    '.mail-Message-Sender-Name',
    '[class*="Message-Sender"]',
    '[class*="Message-From"]',
    '[data-testid*="sender" i]',
    '[data-testid*="from" i]',
    '[data-email]',
    '[class*="sender" i]',
    '[class*="Sender" i]',
    '[class*="From" i]',
    '[title*="@"]',
    'a[href^="mailto:"]',
  ];

  const YANDEX_TO_SELECTORS = [
    '.mail-Message-To',
    '.mail-Message-Header-To',
    '.mail-Message-Recipient',
    '.mail-Message-Header-Recipient',
    '[data-testid*="recipient" i]',
    '[data-testid*="to" i]',
    '[class*="Message-To" i]',
    '[class*="Recipient" i]',
  ];

  const YANDEX_TIME_SELECTORS = [
    '.mail-Message-Date',
    '.mail-Message-Header-Date',
    '.mail-Message-Time',
    '[data-testid*="date" i]',
    '[data-testid*="time" i]',
    '[class*="Message-Date" i]',
    '[class*="date" i]',
    '[class*="time" i]',
    'time',
  ];

  const YANDEX_BODY_SELECTORS = [
    '.mail-Message-Body',
    '.mail-Message-Body-Content',
    '.mail-Message-Content',
    '[class*="Message-Body"]',
    '[class*="Body-Content"]',
  ];

  // Сниппеты списка писем: не должны попадать в тред.
  const YANDEX_SNIPPET_SELECTOR = '.mail-MessageSnippet, [class*="Snippet"]';
  // Вложенные в тело цитаты: не считаем их отдельными сообщениями треда.
  const YANDEX_QUOTED_SELECTOR = '.mail-Message-Body, .mail-Message-Body-Content, [class*="quote" i], [class*="Quote"]';

  // Шапка карточки: эти данные уже извлечены отдельно и не должны дублироваться в теле.
  const YANDEX_HEADER_NOISE = [
    '.mail-Message-Sender',
    '.mail-Message-Header-Sender',
    '.mail-Message-Date',
    '.mail-Message-Header-Date',
    '[data-testid*="sender" i]',
    '[data-testid*="from" i]',
    '[data-testid*="date" i]',
    '[data-testid*="time" i]',
    '[class*="sender" i]',
  ].join(', ');

  /** Тело письма в BEM-разметке (или null, если карточка — не письмо). */
  /**
   * Тело BEM-письма без вложенной истории: вырезаем цитаты (blockquote, вложенные
   * .mail-Message/.mail-Message-Body) и хвосты-шапки «… пишет:». Если после чистки
   * ничего не осталось — отдаём исходный текст, чтобы не потерять сообщение.
   */
  function cleanYandexBody(element) {
    try {
      const originalText = normalizeText(nodeToText(element));
      const clone = element.cloneNode(true);
      const noiseSelectors = [
        'blockquote',
        '[class*="quote" i]',
        '[class*="Quote"]',
        '[class*="цитата" i]',
        '.mail-Message',
        '.mail-Thread-Message',
        '.mail-Message-Body',
        '.mail-Message-Body-Content',
        '[class*="Forward" i]',
        '[class*="forwarded" i]',
        '[class*="Пересыл" i]',
      ];
      for (const node of clone.querySelectorAll(noiseSelectors.join(', '))) node.remove();
      let value = normalizeText(nodeToText(clone));
      // Открытое письмо: только собственный текст до цитаты/пересылаемого блока.
      const kept = [];
      let stopped = false;
      for (const line of value.split('\n')) {
        const trimmed = line.trim();
        if (stopped) continue;
        if (
          /^[-—]{2,}\s*(?:пересылаемое|forwarded|original)/i.test(trimmed) ||
          /пересылаемое сообщение|forwarded message|original message/i.test(trimmed)
        ) {
          stopped = true;
          continue;
        }
        if (/^\s*>/.test(line)) continue;
        if (/(?:^|[\s,])(?:пишет|писал\(а\)|писала|написал\(а\)|wrote)\s*:\s*$/i.test(trimmed)) {
          stopped = true;
          continue;
        }
        if (/^(?:Кому|Тема|От|To|Subject|From)\s*:/i.test(trimmed)) {
          stopped = true;
          continue;
        }
        kept.push(line);
      }
      value = normalizeText(kept.join('\n'));
      // Не откатываемся к originalText, если там была цитата/пересылка.
      if (!value && !/пересылаемое|forwarded|original message|пишет\s*:/i.test(originalText)) {
        return originalText.slice(0, LIMITS.mailChars);
      }
      return value.slice(0, LIMITS.mailChars);
    } catch {
      return '';
    }
  }

  function yandexBodyElement(node, isVisible = null) {
    for (const selector of YANDEX_BODY_SELECTORS) {
      let elements;
      try {
        elements = node.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (element.closest(YANDEX_SIDEBAR_SELECTOR)) continue;
        if (isVisible && !isVisible(element)) continue;
        const value = element.innerText || element.textContent || '';
        if (value.trim().length >= 20) return element;
      }
    }
    return null;
  }

  /** Область чтения открытого письма: приоритет явным контейнерам, не document.body/layout. */
  function yandexReadingPane(isVisible) {
    const inSidebar = (node) => Boolean(node && node.closest && node.closest(YANDEX_SIDEBAR_SELECTOR));
    const hasMessage = (node) => {
      if (!node || typeof node.querySelector !== 'function') return false;
      if (node.matches && node.matches('[class*="list" i], [role="list"]')) return false;
      const body = Array.from(node.querySelectorAll('.mail-Message-Body, .mail-Message-Body-Content')).find(
        (element) => isVisible(element) && !inSidebar(element),
      );
      if (body) return true;
      return Array.from(node.querySelectorAll('.mail-Message, .mail-Thread-Message')).some(
        (element) => isVisible(element) && !inSidebar(element),
      );
    };
    for (const selector of YANDEX_READING_PANE_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (!isVisible(node) || inSidebar(node)) continue;
        if (hasMessage(node)) return node;
      }
    }
    const roleMain = document.querySelector('[role="main"]');
    if (roleMain && isVisible(roleMain) && !inSidebar(roleMain) && hasMessage(roleMain)) return roleMain;
    // Fallback: видимое тело вне сайдбара уже достаточно. Берём карточку вокруг самого
    // большого тела (Fwd/классический layout без .mail-MessageView/[role=main]).
    const bodies = Array.from(
      document.querySelectorAll('.mail-Message-Body, .mail-Message-Body-Content, [class*="Message-Body" i]'),
    )
      .filter((element) => isVisible(element) && !inSidebar(element))
      .sort((a, b) => String(b.textContent || '').length - String(a.textContent || '').length);
    for (const visibleBody of bodies) {
      const card =
        visibleBody.closest('.mail-Message, .mail-Thread-Message') ||
        visibleBody.closest('[class*="MessageView" i], [class*="Message-View" i], [class*="Mail-Message" i]');
      if (card && isVisible(card) && !inSidebar(card)) return card;
      if (visibleBody.parentElement && !inSidebar(visibleBody.parentElement)) return visibleBody.parentElement;
    }
    return null;
  }

  function yandexSubject(main, isVisible) {
    for (const selector of YANDEX_SUBJECT_SELECTORS) {
      let nodes;
      try {
        nodes = main.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        if (node.closest(YANDEX_SIDEBAR_SELECTOR)) continue;
        const value = text(node.innerText || node.textContent);
        if (value.length >= 2 && value.length <= 240) return value;
      }
    }
    return text(document.title).replace(/\s*[—–-]\s*(?:Яндекс.*|Yandex.*)$/i, '').trim();
  }

  /** Элементы шапки карточки, не принадлежащие вложенным/цитируемым письмам. */
  function yandexFirstBody(node) {
    if (!node || typeof node.querySelector !== 'function') return null;
    for (const selector of YANDEX_BODY_SELECTORS) {
      let elements;
      try {
        elements = node.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (!element.closest(YANDEX_SIDEBAR_SELECTOR)) return element;
      }
    }
    return null;
  }

  function yandexOwnHeaderElements(node, selectors) {
    const found = [];
    const firstBody = yandexFirstBody(node);
    for (const selector of selectors) {
      let elements;
      try {
        elements = node.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (element.closest('.mail-Message-Body, .mail-Message-Body-Content')) continue;
        if (element.closest('blockquote, [class*="quote" i], [class*="цитата" i]')) continue;
        if (element.closest(YANDEX_SNIPPET_SELECTOR)) continue;
        if (element.closest(YANDEX_SIDEBAR_SELECTOR)) continue;
        if (element.closest('[class*="Forward" i], [class*="forwarded" i], [class*="Пересыл" i]')) continue;
        const owner = element.closest('.mail-Message, .mail-Thread-Message');
        if (owner && owner !== node) continue;
        // Шапка открытого письма — только элементы ДО первого тела.
        if (firstBody) {
          if (element.contains(firstBody)) continue;
          if (!(element.compareDocumentPosition(firstBody) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        }
        found.push(element);
      }
    }
    return found;
  }

  /** Текст шапки без тела/вложенных писем — для fallback-парсинга «От:/Кому:/дата». */
  function yandexHeaderRegion(node) {
    const clone = node.cloneNode(true);
    for (const body of clone.querySelectorAll('.mail-Message-Body, .mail-Message-Body-Content')) body.remove();
    for (const nested of clone.querySelectorAll('.mail-Message, .mail-Thread-Message')) nested.remove();
    for (const quoted of clone.querySelectorAll(
      'blockquote, [class*="quote" i], [class*="цитата" i], [class*="Forward" i], [class*="forwarded" i], [class*="Пересыл" i]',
    )) {
      quoted.remove();
    }
    const lines = normalizeText(nodeToText(clone)).split('\n');
    // Всё после маркера пересылки/цитаты — уже не шапка открытого письма.
    const stop = lines.findIndex((line) =>
      /пересылаемое сообщение|forwarded message|original message|---+\s*$/i.test(line),
    );
    return normalizeText((stop >= 0 ? lines.slice(0, stop) : lines).join('\n')).slice(0, 1200);
  }

  function elementTextWithoutAvatar(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    for (const noise of clone.querySelectorAll('[class*="Avatar" i], [class*="avatar" i], [class*="Initials" i], img, svg')) {
      noise.remove();
    }
    return text(clone.textContent);
  }

  function cleanHeaderValue(value, kind) {
    let result = text(value);
    if (!result) return '';
    result = result.replace(/^(?:От|Отправитель|From|Sender|Кому|To|Получатель)\s*:\s*/i, '').trim();
    result = result.replace(/\s*(?:Кому|To|Получатель)\s*:.*$/i, '').trim();
    if (kind === 'to') result = result.replace(/\s*(?:Тема|Subject)\s*:.*$/i, '').trim();
    if (!result || result.length < 2) return '';
    if (/^(?:я|вы|от|кому|to|from|sender|recipient|получатель)$/i.test(result)) return '';
    // В шапке не должно быть цитатных полей/разделителей пересылки.
    if (kind === 'sender' && /(?:^|\s)(?:кому|тема|subject|to)\s*:/i.test(result)) return '';
    if (/^-{2,}|пересылаемое сообщение|forwarded message/i.test(result)) return '';
    return result.slice(0, 200);
  }

  function findEmail(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return '';
    const elements = [
      scope,
      ...scope.querySelectorAll('[title*="@"], [aria-label*="@"], [data-email], [email], a[href^="mailto:"]'),
    ];
    for (const element of elements) {
      for (const attribute of ['title', 'aria-label', 'data-email', 'email', 'href']) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const match = String(value).match(/[^\s<>"'(),;]+@[^\s<>"',;]+/);
        if (match) return match[0].replace(/^mailto:/i, '');
      }
    }
    return '';
  }

  function yandexSender(node) {
    for (const element of yandexOwnHeaderElements(node, YANDEX_SENDER_SELECTORS)) {
      let value = cleanHeaderValue(
        elementTextWithoutAvatar(element) ||
          element.getAttribute('title') ||
          element.getAttribute('email') ||
          element.getAttribute('data-email') ||
          element.getAttribute('aria-label'),
        'sender',
      );
      if (!value || (value.length <= 2 && !/@/.test(value))) continue;
      if (!/@/.test(value)) {
        const email = findEmail(element) || findEmail(element.parentElement);
        if (email && !value.includes(email)) value = `${value} <${email}>`;
      }
      return value;
    }
    // Fallback: строка «От: …» в шапке (не в теле/пересылаемом блоке).
    const header = yandexHeaderRegion(node);
    const line = header.split('\n').find((entry) => /^\s*(?:От|From|Отправитель)\s*:/i.test(entry));
    if (line) {
      const value = cleanHeaderValue(line, 'sender');
      if (value) return value;
    }
    const headerElement = node.querySelector('.mail-Message-Header, [class*="Header" i]');
    if (!headerElement) return '';
    const firstBody = yandexFirstBody(node);
    if (firstBody && (headerElement.contains(firstBody) || !(headerElement.compareDocumentPosition(firstBody) & Node.DOCUMENT_POSITION_FOLLOWING))) {
      return '';
    }
    return findEmail(headerElement);
  }

  function yandexRecipient(node) {
    for (const element of yandexOwnHeaderElements(node, YANDEX_TO_SELECTORS)) {
      const value = cleanHeaderValue(
        elementTextWithoutAvatar(element) || element.getAttribute('title') || element.textContent,
        'to',
      );
      if (value) return value;
    }
    const header = yandexHeaderRegion(node);
    const line = header.split('\n').find((entry) => /^\s*(?:Кому|To|Получатель)\s*:/i.test(entry));
    return line ? cleanHeaderValue(line, 'to') : '';
  }

  function looksLikeYandexDate(value) {
    return /\d{1,2}[:.]\d{2}/.test(value) || /\d{1,2}\s+(?:янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)/i.test(value);
  }

  function yandexTime(node) {
    for (const element of yandexOwnHeaderElements(node, YANDEX_TIME_SELECTORS)) {
      const raw = text(
        element.getAttribute('title') || element.getAttribute('datetime') || element.innerText || element.textContent,
      );
      const value = raw.replace(/^(?:Дата|Date|Время|Time)\s*:\s*/i, '').trim();
      if (value && value.length <= 80 && looksLikeYandexDate(value)) return value;
    }
    const header = yandexHeaderRegion(node);
    const line = header.split('\n').find((entry) => looksLikeYandexDate(entry) && entry.length <= 100);
    return line
      ? line.replace(/^(?:Дата|Date|Время|Time)\s*:\s*/i, '').trim().slice(0, 80)
      : '';
  }

  function collectYandexMessageNodes(main, isVisible) {
    // 1) Классический BEM-UI Яндекс 360: карточки .mail-Message / .mail-Thread-Message с телом.
    const bem = [];
    // Fallback-reading-pane может быть самой карточкой письма.
    if (main.matches && main.matches('.mail-Message, .mail-Thread-Message') && isVisible(main)) {
      if (!main.closest(YANDEX_SNIPPET_SELECTOR) && !main.closest(YANDEX_SIDEBAR_SELECTOR)) bem.push(main);
    }
    for (const selector of ['.mail-Message', '.mail-Thread-Message']) {
      let nodes;
      try {
        nodes = main.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        if (node.closest(YANDEX_SNIPPET_SELECTOR) || node.closest(YANDEX_SIDEBAR_SELECTOR) || node.closest(YANDEX_QUOTED_SELECTOR)) continue;
        if (!yandexBodyElement(node, isVisible) && !extractYandexAttachments(node).length) continue;
        bem.push(node);
      }
    }
    const bemInnermost = bem.filter((node) => !bem.some((other) => other !== node && node.contains(other)));
    if (bemInnermost.length) return bemInnermost.slice(-8);

    // 2) Современный React-UI и прочие эвристики по data-testid/классам.
    const seen = new Set();
    const found = [];
    for (const selector of YANDEX_MESSAGE_SELECTORS) {
      // Явные data-testid — надёжнее; для хешированных классов порог выше, чтобы не ловить обёртки.
      const minChars = selector.indexOf('[data-testid') === 0 ? 40 : 120;
      let nodes;
      try {
        nodes = main.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (seen.has(node) || !isVisible(node)) continue;
        if (node.closest(YANDEX_SNIPPET_SELECTOR) || node.closest(YANDEX_SIDEBAR_SELECTOR) || node.closest(YANDEX_QUOTED_SELECTOR)) continue;
        const value = node.innerText || node.textContent || '';
        if (value.trim().length < minChars && !extractYandexAttachments(node).length) continue;
        seen.add(node);
        found.push(node);
      }
      if (found.length >= 2) break;
    }
    // Оставляем самые вложенные карточки: внешние контейнеры дублируют весь список.
    const innermost = found.filter((node) => !found.some((other) => other !== node && node.contains(other)));
    return innermost.slice(-8);
  }

  function extractYandexThread() {
    const isVisible = makeVisibilityCache();
    const main = yandexReadingPane(isVisible);
    if (!main) return null;
    const subject = yandexSubject(main, isVisible);
    const nodes = collectYandexMessageNodes(main, isVisible);
    const messages = [];
    const keptNodes = [];
    const participants = [];
    for (const node of nodes) {
      const sender = yandexSender(node);
      // BEM: тело — отдельный узел .mail-Message-Body; modern UI — весь card минус шапка.
      const attachments = extractYandexAttachments(node);
      const bodyElement = yandexBodyElement(node, isVisible);
      // Если тела нет, но есть вложения — не подставляем текст плашки как тело письма.
      const body = bodyElement ? cleanYandexBody(bodyElement) : attachments.length ? '' : cleanMailBody(node, YANDEX_HEADER_NOISE);
      if (!body && !attachments.length) continue;
      messages.push({
        from: sender,
        to: yandexRecipient(node),
        time: yandexTime(node),
        text: body || (attachments.length ? '(без текста, см. вложения)' : '(без текста)'),
        attachments,
      });
      keptNodes.push(node);
      if (sender) participants.push(sender);
    }
    if (messages.length) {
      const hasSender = messages.some((message) => message.from);
      const focused = finalizeOpen(messages, keptNodes);
      return {
        site: 'yandex',
        subject,
        participants: [...new Set(participants)].slice(0, 10),
        messages: focused.threadMessages,
        threadMessages: focused.threadMessages,
        openMessage: focused.openMessage,
        openIndex: focused.openIndex,
        // Структура распознана не полностью, если нет темы или отправителя — честно помечаем.
        degraded: !subject || !hasSender,
        url: location.href,
      };
    }
    // Fallback: только область чтения как одно сообщение, без сайдбара/списков.
    // Логин-экран и пустой интерфейс не отдаём как «письмо»: в письме всегда есть адрес.
    const fallbackClone = main.cloneNode(true);
    for (const sidebar of fallbackClone.querySelectorAll(YANDEX_SIDEBAR_SELECTOR)) sidebar.remove();
    const paneText = normalizeText(nodeToText(fallbackClone)).slice(0, LIMITS.mailChars);
    if (!paneText || !/@/.test(paneText)) return null;
    const sender = (() => {
      const mailtos = Array.from(fallbackClone.querySelectorAll('a[href^="mailto:"]'));
      const mailto = mailtos.find((element) => !element.closest(YANDEX_SIDEBAR_SELECTOR));
      if (mailto) return text(mailto.getAttribute('href').replace(/^mailto:/i, ''));
      const withEmail = Array.from(fallbackClone.querySelectorAll('[title*="@"], [aria-label*="@"]'))
        .filter((element) => !element.closest(YANDEX_SIDEBAR_SELECTOR))
        .map((element) => text(element.getAttribute('title') || element.getAttribute('aria-label')))
        .find((value) => /@/.test(value));
      return withEmail || '';
    })();
    const fallbackMessage = { from: sender, to: '', time: '', text: paneText, attachments: extractAttachments(main, 'yandex') };
    return {
      site: 'yandex',
      subject,
      participants: sender ? [sender] : [],
      messages: [fallbackMessage],
      threadMessages: [fallbackMessage],
      openMessage: fallbackMessage,
      openIndex: 0,
      degraded: true,
      url: location.href,
    };
  }

  /* ------------------------------------------------------------------ */
  /* mail context                                                       */
  /* ------------------------------------------------------------------ */

  function extractMailContext() {
    const site = detectSite();
    if (site === 'gmail') return extractGmailThread();
    if (site === 'outlook') return extractOutlookThread();
    if (site === 'yandex') return extractYandexThread();
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* composer                                                           */
  /* ------------------------------------------------------------------ */

  function composerCandidates() {
    const selectors = [
      // Яндекс 360 / классическая Яндекс Почта (BEM). Если тело в iframe — fallback в буфер.
      '.mail-Compose-Body[contenteditable="true"]',
      '.mail-Compose-Body-Content[contenteditable="true"]',
      '.mail-Compose-Body [contenteditable="true"]',
      '[class*="Compose-Body"] [contenteditable="true"]',
      'div[aria-label="Message Body"][contenteditable="true"]',
      'div[aria-label*="Message Body" i][contenteditable="true"]',
      'div[aria-label*="Message body" i][contenteditable="true"]',
      'div.Am.Al.editable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="essage" i]',
      '[data-automationid="textEditor"][contenteditable="true"]',
      '.cke_editable[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];
    const seen = new Set();
    const out = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !isUsableComposer(el)) continue;
        seen.add(el);
        out.push(el);
      }
      if (out.length) break;
    }
    return out;
  }

  function isUsableComposer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 20) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Исключаем поисковую строку и прочие мелкие редактируемые поля.
    if (/search|поиск/i.test(el.getAttribute('aria-label') || '') || /search|поиск/i.test(el.getAttribute('placeholder') || '')) return false;
    return true;
  }

  function findComposer() {
    const candidates = composerCandidates();
    if (!candidates.length) return null;
    // Приоритет: самый большой по площади видимый редактируемый контейнер.
    return candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, area: rect.width * rect.height };
      })
      .sort((a, b) => b.area - a.area)[0].el;
  }

  function composerText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return normalizeText(el.innerText || el.textContent || '');
  }

  function readComposer() {
    const el = findComposer();
    if (!el) return { ok: false, found: false, text: '', reason: 'COMPOSER_NOT_FOUND' };
    return { ok: true, found: true, text: composerText(el).slice(0, LIMITS.comptoserChars), tag: el.tagName.toLowerCase() };
  }

  function placeCaretAtEnd(el) {
    try {
      el.focus({ preventScroll: false });
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      try {
        el.focus();
        return true;
      } catch {
        return false;
      }
    }
  }

  function dispatchInput(el, inserted) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: inserted }));
    } catch {
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        /* ignore */
      }
    }
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      /* ignore */
    }
  }

  function composerContains(el, sample) {
    const probe = normalizeText(sample).slice(0, 40);
    if (!probe) return false;
    const current = normalizeText(composerText(el));
    return current.includes(probe.slice(0, 20));
  }

  function findComposerIframe() {
    // В классической Яндекс Почте/360 тело ответа может жить в iframe — из top-frame не достать.
    const selectors = [
      'iframe[id*="compose" i]',
      'iframe[class*="compose" i]',
      'iframe[name*="compose" i]',
      'iframe[src*="compose" i]',
      'iframe[class*="mail-Compose" i]',
      'iframe[id*="mail-Compose" i]',
    ];
    for (const selector of selectors) {
      let frame;
      try {
        frame = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!frame) continue;
      const rect = frame.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 40) return frame;
    }
    return null;
  }

  /**
   * Вставка текста в композер. Не отправляет письмо.
   * @returns {{ok:boolean, strategy?:string, reason?:string, composer?:string}}
   */
  function insertIntoComposer(rawText) {
    const content = String(rawText || '');
    if (!content.trim()) return { ok: false, reason: 'EMPTY_TEXT' };
    const el = findComposer();
    if (!el) {
      // Понятная деградация: в top-frame композера нет, но он может быть в iframe.
      return { ok: false, reason: findComposerIframe() ? 'COMPOSER_IN_IFRAME' : 'COMPOSER_NOT_FOUND' };
    }
    const existing = composerText(el);
    const prefix = existing.trim() ? '\n\n' : '';
    const payload = `${prefix}${content}`;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        el.focus();
        const end = String(el.value || '').length;
        el.setSelectionRange(end, end);
        const inserted = document.execCommand('insertText', false, payload);
        if (!inserted) {
          el.value = `${el.value || ''}${payload}`;
          dispatchInput(el, payload);
        }
        if (composerContains(el, content)) return { ok: true, strategy: 'input-insert', composer: 'generic' };
      } catch {
        /* падаем в contenteditable-ветку не нужно — это input */
      }
      return { ok: false, reason: 'INSERT_FAILED' };
    }

    const strategies = [
      {
        name: 'execCommand-insertText',
        run: () => {
          placeCaretAtEnd(el);
          return document.execCommand('insertText', false, payload);
        },
      },
      {
        name: 'execCommand-insertHTML',
        run: () => {
          placeCaretAtEnd(el);
          const escaped = payload
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          return document.execCommand('insertHTML', false, escaped);
        },
      },
      {
        name: 'textContent-fallback',
        run: () => {
          if (existing.trim()) return false;
          el.textContent = payload;
          dispatchInput(el, payload);
          return composerContains(el, content);
        },
      },
    ];

    for (const strategy of strategies) {
      try {
        strategy.run();
      } catch {
        continue;
      }
      if (composerContains(el, content)) {
        dispatchInput(el, payload);
        return { ok: true, strategy: strategy.name, composer: detectSite() || 'generic' };
      }
    }
    return { ok: false, reason: 'INSERT_FAILED' };
  }

  function focusComposer() {
    const el = findComposer();
    if (!el) return { ok: false, reason: 'COMPOSER_NOT_FOUND' };
    try {
      el.focus();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'FOCUS_FAILED' };
    }
  }

  /* ------------------------------------------------------------------ */
  /* selection                                                          */
  /* ------------------------------------------------------------------ */

  function getSelectionText() {
    try {
      const selection = window.getSelection();
      if (!selection) return '';
      return String(selection.toString() || '').replace(/\u00a0/g, ' ').trim().slice(0, LIMITS.selectionChars);
    } catch {
      return '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* floating launcher (Shadow DOM, чтобы не ломать вёрстку сайта)      */
  /* ------------------------------------------------------------------ */

  let launcherHost = null;
  let launcherObserver = null;
  let observedMailRoot = null;
  let lastKnownHref = location.href;
  let lastKnownSite = null;

  const LAUNCHER_STYLE = `
    :host { all: initial; }
    .wrap { font-family: "Inter Variable", "Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 11px; border: 1px solid rgba(255,255,255,.22);
      border-radius: 6px; cursor: pointer; user-select: none;
      color: #e6e9ef; font: 600 12px/1 system-ui, sans-serif; letter-spacing: .1px;
      background: #2f3440;
      box-shadow: 0 4px 14px rgba(0,0,0,.28);
      transition: background .14s ease, border-color .14s ease, transform .14s ease;
    }
    .btn:hover { background: #363a46; border-color: rgba(255,255,255,.32); }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(230,233,239,.3); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ec264; }
    .btn[data-state="busy"] .dot { background: #d9a441; }
    .btn[data-state="done"] .dot { background: #4ec264; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
  `;

  function launcherPosition() {
    const site = detectSite();
    if (site === 'gmail') return { right: '22px', bottom: '104px' }; // над кнопкой «Написать»
    if (site === 'yandex') return { right: '18px', bottom: '92px' }; // не перекрывает «Написать» (она слева сверху)
    return { right: '22px', bottom: '88px' };
  }

  function mountLauncher() {
    if (!detectSite()) return;
    if (launcherHost && document.contains(launcherHost)) return;
    try {
      const host = document.createElement('div');
      host.id = 'pocherk-launcher';
      host.setAttribute('data-pocherk', 'launcher');
      const pos = launcherPosition();
      host.style.cssText = `all: initial; position: fixed; right: ${pos.right}; bottom: ${pos.bottom}; z-index: 2147483646;`;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = LAUNCHER_STYLE;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.setAttribute('data-state', 'idle');
      button.setAttribute('aria-label', 'AI Bro: открыть панель');
      button.title = 'AI Bro — открыть панель';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = 'AI Bro';
      const sr = document.createElement('span');
      sr.className = 'sr';
      sr.textContent = 'Открыть AI Bro';
      button.append(dot, label, sr);
      wrap.append(button);
      shadow.append(style, wrap);
      host.addEventListener('mousedown', (event) => event.stopPropagation(), true);
      host.addEventListener('click', (event) => event.stopPropagation(), true);
      button.addEventListener('click', onLauncherClick);
      (document.body || document.documentElement).appendChild(host);
      launcherHost = host;
    } catch {
      launcherHost = null;
    }
  }

  async function onLauncherClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    try {
      button.setAttribute('data-state', 'busy');
      // Кнопка только открывает панель: контент не читаем и не передаём.
      await chrome.runtime.sendMessage({ type: 'AI_COPILOT_FROM_PAGE', payload: { kind: 'none' } });
      button.setAttribute('data-state', 'done');
      setTimeout(() => button.setAttribute('data-state', 'idle'), 1200);
    } catch {
      button.setAttribute('data-state', 'idle');
    }
  }

  function removeLauncher() {
    if (launcherHost && launcherHost.parentNode) launcherHost.remove();
    launcherHost = null;
  }

  function syncLauncher() {
    const site = detectSite();
    if (!site) {
      removeLauncher();
      lastKnownHref = location.href;
      lastKnownSite = null;
      return;
    }
    const urlChanged = location.href !== lastKnownHref;
    const siteChanged = site !== lastKnownSite;
    lastKnownHref = location.href;
    lastKnownSite = site;
    // SPA-навигация: после смены URL переустанавливаем кнопку, если её снесли.
    if (siteChanged || urlChanged || !launcherHost || !document.contains(launcherHost)) {
      removeLauncher();
      mountLauncher();
    }
  }

  function startLauncherObserver() {
    if (!detectSite()) return;
    if (launcherObserver) return;
    lastKnownSite = detectSite();
    lastKnownHref = location.href;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        syncLauncher();
      }, 300);
    };
    launcherObserver = new MutationObserver((records) => {
      if (document.visibilityState === 'visible' && isMailMutation(records)) scheduleMailChangePush();
      schedule();
      if (!observedMailRoot || !document.contains(observedMailRoot)) observeMailRoot();
    });
    function observeMailRoot() {
      const root = document.querySelector('[role="main"], main') || document.body;
      if (!root || root === observedMailRoot) return;
      launcherObserver.disconnect();
      launcherObserver.observe(root, { childList: true, subtree: true });
      observedMailRoot = root;
    }
    observeMailRoot();
    window.addEventListener('popstate', () => {
      observeMailRoot();
      schedule();
    }, true);
    window.addEventListener('hashchange', () => {
      observeMailRoot();
      schedule();
    }, true);
    // Navigation API (если есть) — корректный способ ловить SPA-переходы без
    // патча history.pushState (в isolated world он бесполезен и опасен).
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', () => {
        observeMailRoot();
        schedule();
      });
    }
    // Дешёвый fallback: проверяем URL/наличие кнопки, не трогая DOM почты.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!observedMailRoot || !document.contains(observedMailRoot)) observeMailRoot();
      if (location.href === lastKnownHref && launcherHost && document.contains(launcherHost)) return;
      syncLauncher();
    }, 2500);
  }

  /* ------------------------------------------------------------------ */
  /* messaging                                                          */
  /* ------------------------------------------------------------------ */

  function respond(fn) {
    try {
      return fn();
    } catch (error) {
      return { ok: false, reason: 'ERROR', message: String((error && error.message) || error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'content') return undefined;
    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, version: VERSION, site: detectSite(), isMail: !!detectSite() });
        return undefined;
      case 'GET_PAGE':
        sendResponse(respond(() => ({ ok: true, page: extractMainContent() })));
        return undefined;
      case 'GET_MAIL':
        sendResponse(respond(() => {
          const mail = extractMailContext();
          return mail ? { ok: true, mail } : { ok: false, reason: 'NOT_WEBMAIL' };
        }));
        return undefined;
      case 'GET_SELECTION':
        sendResponse({ ok: true, text: getSelectionText() });
        return undefined;
      case 'GET_COMPOSER':
        sendResponse(respond(readComposer));
        return undefined;
      case 'INSERT_TEXT':
        sendResponse(respond(() => insertIntoComposer(message.text)));
        return undefined;
      case 'FOCUS_COMPOSER':
        sendResponse(respond(focusComposer));
        return undefined;
      case 'SHOW_LAUNCHER':
        respond(() => {
          mountLauncher();
          startLauncherObserver();
          return { ok: true };
        });
        sendResponse({ ok: true });
        return undefined;
      default:
        sendResponse({ ok: false, reason: 'UNKNOWN_TYPE' });
        return undefined;
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  // Изменения DOM внутри писем; клики/фокус/picker не используются.
  if (detectSite()) {
    mountLauncher();
    startLauncherObserver();
    // Плавающая кнопка могла не создать из-за ещё не готового body.
    setTimeout(() => {
      if (!launcherHost || !document.contains(launcherHost)) mountLauncher();
    }, 1500);
  }
})();
