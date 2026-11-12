/**
 * lib/style-profile.js — локальное обучение стилю на правках пользователя.
 *
 * Хранит пары «черновик модели → финальный текст пользователя» ТОЛЬКО в
 * chrome.storage.local. На сервер ничего не уходит: агрегированные правила
 * выводятся эвристиками здесь же и подмешиваются в системный промпт.
 */

import { LIMITS, clamp } from './config.js';

export const LENGTHS = Object.freeze([
  { id: 'short', label: 'Коротко (2–4 предложения)' },
  { id: 'normal', label: 'Средне (абзац)' },
  { id: 'detailed', label: 'Подробно (2 абзаца)' },
]);

export const EMOJI_OPTIONS = Object.freeze([
  { id: 'never', label: 'Не использовать' },
  { id: 'rarely', label: 'Редко' },
  { id: 'ok', label: 'Уместно' },
]);

export const DEFAULT_PROFILE = Object.freeze({
  schema: 1,
  prefs: {
    formality: 3,
    length: 'normal',
    emoji: 'rarely',
    address: 'вы',
    signature: '',
    signoff: '',
  },
  samples: [],
  rules: [],
  updatedAt: 0,
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeProfile(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  if (!isPlainObject(raw)) return base;
  const prefs = isPlainObject(raw.prefs) ? raw.prefs : {};
  base.prefs.formality = Math.round(clamp(prefs.formality ?? base.prefs.formality, 1, 5));
  base.prefs.length = LENGTHS.some((l) => l.id === prefs.length) ? prefs.length : base.prefs.length;
  base.prefs.emoji = EMOJI_OPTIONS.some((e) => e.id === prefs.emoji) ? prefs.emoji : base.prefs.emoji;
  base.prefs.address = prefs.address === 'ты' ? 'ты' : 'вы';
  base.prefs.signature = String(prefs.signature || '').slice(0, 400);
  base.prefs.signoff = String(prefs.signoff || '').slice(0, 200);
  base.samples = Array.isArray(raw.samples)
    ? raw.samples
        .filter((s) => isPlainObject(s) && typeof s.draft === 'string' && typeof s.final === 'string')
        .slice(-LIMITS.maxSamples)
        .map((s) => ({
          id: String(s.id || ''),
          ts: Number(s.ts) || 0,
          kind: String(s.kind || 'reply').slice(0, 40),
          draft: s.draft,
          final: s.final,
        }))
    : [];
  base.rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r) => r && typeof r.text === 'string').map((r) => ({ id: String(r.id || ''), text: r.text, weight: Number(r.weight) || 1 }))
    : [];
  base.updatedAt = Number(raw.updatedAt) || 0;
  return base;
}

const GREETINGS = [
  { id: 'zdravstvuyte', re: /^(здравствуйте|добрый день|добрый вечер|доброе утро)/i, text: '«Здравствуйте» / «Добрый день»' },
  { id: 'privet', re: /^(привет|приветствую|хай)/i, text: '«Привет»' },
  { id: 'kollegi', re: /^(коллеги|добрый день, коллеги)/i, text: 'обращение «Коллеги»' },
  { id: 'imya', re: /^(иван|анна|сергей|мария|алексей|елена|дмитрий|ольга)\b/i, text: 'сразу по имени' },
];

const SIGNOFFS = /(с уважением|с наилучшими|всего доброго|спасибо|благодарю|best regards|kind regards|regards|cheers)/i;
const FORMAL_MARKERS = ['пожалуйста', 'буду признателен', 'буду признательна', 'прошу', 'не могли бы вы', 'заранее спасибо', 'коллеги', 'уважаемый', 'уважаемая'];

function emojiCount(text) {
  try {
    const matches = String(text).match(/\p{Extended_Pictographic}/gu);
    return matches ? matches.length : 0;
  } catch {
    return (String(text).match(/[\u2600-\u27bf]|[\ud83c-\ud83e][\udc00-\udfff]/g) || []).length;
  }
}

function countWords(text) {
  return (String(text).match(/[A-Za-zА-Яа-яЁё0-9]+/g) || []).length;
}

function addressStats(text) {
  const lower = String(text).toLowerCase();
  const vy = (lower.match(/(^|[^а-яё])(вы|вас|вам|ваш|ваша|ваше|ваши)(?![а-яё])/g) || []).length;
  const ty = (lower.match(/(^|[^а-яё])(ты|тебя|тебе|твой|твоя|твоё|твои)(?![а-яё])/g) || []).length;
  return { vy, ty };
}

function sentenceStats(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?…]+[.!?…]+/g) || (clean ? [clean] : []);
  const totalWords = countWords(clean);
  return {
    sentences: sentences.length,
    avgWords: sentences.length ? totalWords / sentences.length : totalWords,
    exclamations: (clean.match(/!/g) || []).length,
  };
}

/** Правила из одной пары. */
function rulesFromPair(sample) {
  const out = [];
  const draft = sample.draft.trim();
  const final = sample.final.trim();
  if (!draft || !final) return out;
  const ratio = final.length / Math.max(1, draft.length);
  if (ratio < 0.72) out.push({ id: 'shorter', text: `Сокращает черновики примерно на ${Math.round((1 - ratio) * 100)}%.`, weight: 1 });
  else if (ratio > 1.25) out.push({ id: 'longer', text: 'Обычно дополняет черновик деталями.', weight: 1 });

  const firstLine = final.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const greeting = GREETINGS.find((g) => g.re.test(firstLine));
  if (greeting && !GREETINGS.find((g) => g.re.test(draft.split('\n').map((l) => l.trim()).find(Boolean) || ''))) {
    out.push({ id: `greeting_${greeting.id}`, text: `Начинает письмо: ${greeting.text}.`, weight: 1 });
  }

  const finalLines = final.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = finalLines[finalLines.length - 1] || '';
  const signoffMatch = lastLine.match(SIGNOFFS);
  if (signoffMatch) {
    out.push({ id: 'signoff', text: `Подписывается: «${signoffMatch[0]}».`, weight: 1 });
  }

  const address = addressStats(final);
  if (address.ty > address.vy && address.ty >= 2) {
    out.push({ id: 'ty', text: 'Обращается на «ты».', weight: 1 });
  } else if (address.vy > 0) {
    out.push({ id: 'vy', text: 'Обращается на «вы».', weight: 1 });
  }

  const finalEmoji = emojiCount(final);
  if (finalEmoji > 0) out.push({ id: 'emoji', text: 'Иногда использует эмодзи.', weight: 1 });
  else if (emojiCount(draft) > 0) out.push({ id: 'no_emoji', text: 'Убирает эмодзи из черновика.', weight: 1 });

  const formal = FORMAL_MARKERS.filter((m) => final.toLowerCase().includes(m)).length;
  if (formal >= 2) out.push({ id: 'formal', text: 'Держится формального тона: «пожалуйста», «прошу», «буду признателен».', weight: 1 });
  else if (formal === 0 && final.length > 80) out.push({ id: 'plain', text: 'Пишет проще, без канцелярита.', weight: 1 });

  const sentence = sentenceStats(final);
  if (sentence.avgWords > 22) out.push({ id: 'long_sentences', text: 'Использует длинные предложения.', weight: 1 });
  if (sentence.avgWords > 0 && sentence.avgWords < 12) out.push({ id: 'short_sentences', text: 'Предпочитает короткие предложения.', weight: 1 });

  return out;
}

/** Агрегирует правила по всем парам, дедуп + вес (частота). */
export function deriveRules(samples, prefs) {
  const bag = new Map();
  for (const sample of samples || []) {
    const pairs = rulesFromPair(sample);
    for (const rule of pairs) {
      const prev = bag.get(rule.id);
      if (prev) prev.weight += 1;
      else bag.set(rule.id, { ...rule });
    }
  }
  const total = Math.max(1, (samples || []).length);
  return [...bag.values()]
    .filter((rule) => (rule.weight > 1 || total === 1) && rule.id !== 'greeting_imya')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map((rule) => ({ id: rule.id, text: rule.text, weight: rule.weight }));
}

/**
 * Добавить пару «черновик → финальный текст».
 * @returns {{profile:object, learned:boolean, reason:string, delta:number}}
 */
export function learnFromPair(rawProfile, { draft, finalText, kind = 'reply' }) {
  const profile = normalizeProfile(rawProfile);
  const cleanDraft = String(draft || '').trim();
  const cleanFinal = String(finalText || '').trim();
  if (cleanFinal.length < 8) return { profile, learned: false, reason: 'Финальный текст слишком короткий.', delta: 0 };
  if (cleanDraft.length < 8) return { profile, learned: false, reason: 'Нет черновика для сравнения.', delta: 0 };
  if (cleanDraft === cleanFinal) return { profile, learned: false, reason: 'Текст не изменён — учиться не на чем.', delta: 0 };
  const last = profile.samples[profile.samples.length - 1];
  if (last && last.draft === cleanDraft && last.final === cleanFinal) {
    return { profile, learned: false, reason: 'Эта правка уже сохранена.', delta: 0 };
  }
  const delta = Number((cleanFinal.length / Math.max(1, cleanDraft.length)).toFixed(2));
  const samples = profile.samples
    .concat([{ id: `s_${Date.now().toString(36)}`, ts: Date.now(), kind: String(kind).slice(0, 40), draft: cleanDraft.slice(0, 8000), final: cleanFinal.slice(0, 8000) }])
    .slice(-LIMITS.maxSamples);
  const rules = deriveRules(samples, profile.prefs);
  return {
    profile: { ...profile, samples, rules, updatedAt: Date.now() },
    learned: true,
    reason: `Правка сохранена (примеров: ${samples.length}).`,
    delta,
  };
}

const FORMALITY_LABELS = {
  1: 'очень неформально',
  2: 'неформально',
  3: 'нейтрально',
  4: 'формально',
  5: 'строго официально',
};

const LENGTH_HINTS = {
  short: '2–4 предложения, без воды',
  normal: 'один абзац, 4–6 предложений',
  detailed: 'два коротких абзаца с деталями',
};

const EMOJI_HINTS = {
  never: 'без эмодзи',
  rarely: 'эмодзи максимум один и только если уместно',
  ok: 'эмодзи допустимы',
};

/** Текстовая секция для системного промпта. */
export function buildStyleHints(rawProfile) {
  const profile = normalizeProfile(rawProfile);
  const prefs = profile.prefs;
  const lines = [];
  lines.push(`- Формальность: ${prefs.formality}/5 (${FORMALITY_LABELS[prefs.formality] || 'нейтрально'}).`);
  lines.push(`- Длина ответа: ${LENGTH_HINTS[prefs.length] || LENGTH_HINTS.normal}.`);
  lines.push(`- Эмодзи: ${EMOJI_HINTS[prefs.emoji] || EMOJI_HINTS.rarely}.`);
  lines.push(`- Обращение: на «${prefs.address}».`);
  if (prefs.signoff) lines.push(`- Подпись/завершение: «${prefs.signoff}».`);
  if (prefs.signature) lines.push(`- Подпись в конце письма:\n${prefs.signature}`);
  if (profile.rules.length) {
    lines.push(`- Наблюдения из правок пользователя (${profile.samples.length} примеров, выведены локально):`);
    for (const rule of profile.rules.slice(0, 10)) lines.push(`  • ${rule.text}`);
  }
  if (!profile.samples.length) {
    lines.push('- Правок ещё не было: стиль задан только настройками, строго их не имитируй сверх указанного.');
  }
  return lines.join('\n');
}

export function profileStats(rawProfile) {
  const profile = normalizeProfile(rawProfile);
  return {
    samples: profile.samples.length,
    rules: profile.rules.length,
    updatedAt: profile.updatedAt,
    maxSamples: LIMITS.maxSamples,
  };
}

export function clearLearning(rawProfile) {
  const profile = normalizeProfile(rawProfile);
  return { ...profile, samples: [], rules: [], updatedAt: Date.now() };
}
