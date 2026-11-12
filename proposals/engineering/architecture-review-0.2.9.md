# Архитектурно-инженерное ревью «Почерк» 0.2.9

**Версия:** 0.2.9 (`manifest.json`, `content.js` VERSION, `dist/pocherk-0.2.9.zip`).
**Дата:** 13.11.2026.
**Что смотрел:** исходники `extension/` (manifest, background, content, sidepanel.*, options.*, `lib/*`, `package.ps1`), zip-артефакт, `architecture.md`, README расширения, скриншоты.
**Чем проверял:** статический разбор; `node --check` 9 JS; JSON/zip инспекция; сверка ссылок manifest/HTML; headless Chrome harness с mock `chrome.*` (options из распакованного zip, sidepanel popup/tabId, stale, requestPage, pending-clear, Gmail degraded); unit-harness для C1/C4/M1; grep секретов/remote code; `chrome --pack-extension` / `msedge --pack-extension`.
**Ограничение:** живые Chrome/Edge с реальным профилем, реальные Gmail/Outlook/Яндекс 360 и живой ключ DeepSeek недоступны — это отмечено в «Осталось».

---

## Вердикт

- **К бете (unpacked):** **условно готово**. Блокеры 0.2.8 закрыты: B1 (zip с `options.js` и проверкой HTML-ссылок), C1 (metadata в nonce-блоке), C2 (открытие панели до `await`, fallback с `tabId`), C3 (stale-guard), C4 (честная проверка модели + 400-fallback), M1–M6/M10. Новых 🔴 не найдено. Перед бетой обязательны живой прогон DeepSeek с ключом, реальные почтовые аккаунты и проверка user-gesture для `sidePanel.open`/fallback.
- **К публикации в Chrome Web Store / Edge Add-ons:** **не готово**. Блокируют store-артефакты (privacy policy, скриншоты 1280×800, точное обоснование optional-хостов), живой QA и мёртвые неиспользуемые ветки провайдеров (N3). Кодовая часть к бете близка; листинг — нет.

---

## Что реально исправлено относительно 0.2.8 (проверено)

| Пункт | Статус 0.2.9 | Доказательство |
| --- | --- | --- |
| 🔴 B1 zip без `options.js` | **закрыт** | `package.ps1:117-130` — `options.js` в payload; `package.ps1:93-112` — проверка local `src/href`; zip **19 записей**, `options.js` в корне; headless options из распакованного zip: 6 `<option>` голоса, badge «доступен» |
| 🟠 C1 injection From/вложения | **закрыт в коде** | `lib/prompts.js:133-143` — `sanitizeUntrusted` + отдельный `wrapUntrusted`-блок; raw-значения не попадают в system; unit 4/4 (инъекция только внутри nonce, system чист) |
| 🟠 C2a sidePanel.open до await | **закрыт в коде** | `background.js:125-151` — синхронный вызов; `background.js:188-235` — меню/команда/action; `background.js:291-299` — плавающая кнопка |
| 🟠 C2b popup-fallback | **закрыт в коде; нужен живой тест** | `background.js:109-118` — `sidepanel.html?tabId=…`; `background.js:342-356` — `GET_TAB`; `sidepanel.js` `popupTabId`/`getActiveTab`; headless: popup берёт контекст из `GET_TAB`, а не из restricted активной вкладки |
| 🟠 C3 stale | **закрыт в коде** | `sidepanel.js:1393` stale; гарды `1516/1611/1653`; сверка темы перед вставкой `1304-1317`; headless: toast, 0 сообщений ассистента |
| 🟠 C4 testConnection/400 | **закрыт в коде** | `lib/llm-client.js:520-543` — `MODEL_NOT_FOUND`/false; `410-422` — один повтор без thinking/reasoning/temperature + `notice`; unit 3/3 |
| 🟡 M1 таймауты | **закрыт** | `lib/llm-client.js:316-323` — first-token только для stream; `375-384` — reasoning-дельты снимают таймер; unit 2/2 |
| 🟡 M2 requestPage | **закрыт** | `background.js:172-181` pending; `sidepanel.js` consume/`init` → `explainPage`; headless: `GET_PAGE`, разбор отрисован |
| 🟡 M3 pending-clear | **закрыт** | `sidepanel.js` после `CONTEXT_PUSH` → `CLEAR_PENDING_CONTEXT`; headless: `cleared=true` |
| 🟡 M4 temperature | **закрыт частично** | `sidepanel.js:1414` прокидывает значение; options подсказка. См. R1 о дефолтах |
| 🟡 M5 degraded | **закрыт в основном** | Gmail: `content.js:487-503` только reading pane, иначе `null`; Outlook без `document.body` (`585`); headless Gmail без письма → `NOT_WEBMAIL`. См. R7 |
| 🟡 M6 observer/history | **закрыт** | `content.js:1445-1477` — main-root observer, visibility, debounce 1.5 с; History-патч удалён; Navigation API + дешёвый interval |
| 🟡 M10 docs | **закрыт** | README: «thinking enabled + reasoning medium», schema 3; architecture: no `user/balance`, «2 повтора = до 3 попыток», tabId-fallback; grep противоречий пуст |

Инструментальные результаты 0.2.9: `node --check` — 9/9 OK; manifest JSON валиден (20 доменов, пути существуют); DOM-id (options 49/33, sidepanel 53/34) — missing пусто; zip 19 файлов, manifest в корне, version 0.2.9; Chrome/Edge pack — exit 0; unit-harness 9/9; grep remote `script src`/eval/секретов — чисто (только SVG namespace и справочные URL площадок ключей).

---

## Находки 0.2.9

### 🟠 R1. M4: глобальный override температуры меняет дефолты качества задач

**Файлы:** `extension/sidepanel.js:1414`, `extension/lib/prompts.js` (`temperature` задач reply 0.6 / summary 0.3 / chat 0.5).

`executeTask` теперь безусловно перезаписывает `task.temperature` значением из настроек (по умолчанию 0.4) для **всех** задач. Это исправляет «слайдер ни на что не влияет», но одновременно меняет прежние дефолты: reply стал 0.4 вместо 0.6, summary — 0.4 вместо 0.3, chat — 0.4 вместо 0.5. Ревью 0.2.8 просило прокинуть температуру «аккуратно, чтобы не сломать дефолты качества»; сейчас это не выполнено.

**Фикс:** отличать «пользователь явно менял температуру» от дефолта: хранить флаг/сравнивать с `DEFAULT_SETTINGS.temperature`, иначе оставлять `task.temperature`; либо задать per-task базовые значения и применять настройку только к reply/chat, оставив summary детерминированной. В любом случае зафиксировать выбранную семантику в README/architecture.

### 🟠 R2. C2: popup-fallback зависит от `tab.url`, который может быть пустым без activeTab/host permission

**Файлы:** `extension/background.js:109-118, 342-356`; `extension/sidepanel.js` (`popupTabId`, `getActiveTab`).

`GET_TAB` использует `chrome.tabs.get(tabId)` и `toTabInfo`, где `isMail`/`restricted` вычисляются по `tab.url`. Без `tabs` permission или выданного `activeTab` поле `url` у `chrome.tabs.Tab` может отсутствовать, особенно в fallback-окне/по команде. Тогда `isMail=false`, `restricted=false`, контекст пуст, а почтовые действия деградируют. Для fallback, открытого из контекстного меню/action, activeTab обычно уже выдан, но это нужно подтвердить живым тестом; для `commands` и `AI_COPILOT_FROM_PAGE` — риск.

**Фикс:** в fallback сохранять целевой `tabId`/URL в pending или передавать ожидаемый URL в `GET_TAB`; если `tab.url` пуст, не считать вкладку обычной, а запросить `activeTab`/использовать `ENSURE_CONTENT` с понятной ошибкой. Инструментально проверить popup-окно из контекстного меню и по `Ctrl+Shift+Y` на Chrome/Edge 114–115/116+.

### 🟠 R3. C3: сверка перед вставкой только по теме; stale-chat оставляет «сиротское» сообщение

**Файлы:** `extension/sidepanel.js:1304-1317`, `extension/sidepanel.js:1492-1530` (`sendChat`), `1516`.

1. `insertTextIntoPage` сравнивает только `subject`. Одинаковая тема у разных тредов/писем (частый случай «Re: …») не ловится — ответ по старому письму всё ещё может быть вставлен в новый композер. Нужно сверять `from`, `focusIndex`/сообщение или thread-id/contains-сравнение.
2. В `sendChat` пользовательское сообщение добавляется в чат **до** `resolveMail`; при `stale` функция делает `return`, оставляя вопрос без ответа и без ошибки в чате (только toast). Для reply/summary гард стоит до добавления сообщения. Нужно либо проверять контекст до `addMessage`, либо помечать сообщение ошибкой «контекст устарел».

**Фикс:** вынести проверку mail в начало `sendChat`/ветки mail; расширить сравнение (subject + from выбранного сообщения + `focusIndex`/thread ID). Это не блокер беты, но снижает риск неверной вставки.

### 🟠 R4. Store readiness: M9-артефакты не готовы

**Файлы/артефакты:** `architecture.md:244-267` (все чек-пункты `[ ]`), `proposals/engineering/screenshots/README.md`, `manifest.json:38-42` (optional hosts).

Нет публичного privacy policy/data-use disclosure; скриншоты не в формате 1280×800 (`options-demo-1280.png` 1280×1150, sidepanel 360/500); в доках широкая optional-хосты (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) обоснованы неполно, а localhost-хосты не имеют потребителя при фиксированном DeepSeek (N3/M9). Для CWS/Edge это вопросы ревьюера и потенциальный отказ.

**Фикс:** privacy policy + data-use disclosure (что уходит в DeepSeek, ключ/история локально, голос — облако браузера); скриншоты 1280×800; точная таблица обоснования optional-хостов (инъекция по кнопке на произвольные сайты) и удаление/обоснование localhost.

### 🟡 R5. C1: `wrapUntrusted` для metadata ограничен 600 символами — имена вложений могут обрезаться

**Файлы:** `extension/lib/prompts.js:133-143` (`wrapUntrusted(..., 600)`), `sanitizeUntrusted` имеет минимум 500.

До 10 имён вложений по ~120 символов не помещаются в 600 символов; при длинных/нескольких файлах хвост `Вложения:` обрежется, и модель снова может «не знать» точное имя. Инъекция при этом остаётся внутри nonce-блока, безопасность не страдает.

**Фикс:** увеличить лимит до ~1500–2000 или собирать метаданные компактно (по 1 строке на файл, обрезка каждого имени), но сохранять все имена; добавить unit на 10 длинных имён.

### 🟡 R6. C4: fallback на 400 срабатывает на любой 400, а не только на неизвестное thinking-поле

**Файлы:** `extension/lib/llm-client.js:410-422`.

Условие `mapped.code === 'BAD_REQUEST' && request.body.thinking` не смотрит на текст ошибки. Любой 400 (битый `max_tokens`, неверная модель, невалидный ключ с 400 от прокси) вызовет лишний повтор без thinking/temperature, что удваивает latency и может замаскировать истинную причину. Ревью просило fallback именно для «неизвестное поле thinking/reasoning_effort».

**Фикс:** проверять `error.hint`/snippet body на `thinking`, `reasoning_effort`, `unknown field`, `unrecognized`; иначе сразу отдавать BAD_REQUEST. Живой DeepSeek-прогон обязателен.

### 🟡 R7. M5: Outlook/Yandex degraded всё ещё могут читать широкий `main`

**Файлы:** `extension/content.js:613-616` (Outlook), `extension/content.js:989-1025` (Yandex fallback).

Gmail ограничен хорошо (`487-503`), Outlook при отсутствии body отдаёт `nodeToText(main)`, а `main` — `[role="main"]`/ReadingPane (в Outlook Web роль main может быть всем приложением). Yandex fallback также берёт `main` с `document.body`. Это лучше, чем `document.body` напрямую, но всё ещё может отправить лишние персональные данные/сниппеты.

**Фикс:** для Outlook ограничить fallback конкретным reading-pane контейнером с признаком сообщения; если его нет — `null`/`NO_THREAD`. Для Yandex fallback — только `[role="main"]` без body, с проверкой `@`/маркеров письма.

### 🟡 R8. M6: observer всё ещё падает на `document.body`, а смена root ловится только интервалом

**Файлы:** `extension/content.js:1449-1477`.

`observeMailRoot` выбирает `[role="main"], main` **или `document.body`**. На почте, где main появляется позже, observer временно висит на body (широкий subtree); при замене main старый observer не получит mutation о собственном удалении, и переподписка произойдёт только по 2.5-секундному interval. Это не регрессия по сравнению с 0.2.8 (стало заметно лучше), но остаточный риск производительности/задержки.

**Фикс:** если main нет — не подписываться на body, а ждать появления main через лёгкий interval/`requestAnimationFrame`; при наличии main сразу `observe(main)`. После смены URL принудительно `disconnect`+`observe` (сейчас есть только `observeMailRoot`, который не переподписывает, если root тот же).

### 🟡 R9. M1: активность reasoning распознаётся только по `choices[0].delta.reasoning_content`

**Файлы:** `extension/lib/llm-client.js:375-384`.

Если фактический SSE DeepSeek отдаёт reasoning в другом поле/форме (например, `reasoning_content` на верхнем уровне или без `choices`), first-token таймер снова сработает через 45 с. Это гипотеза, которую нельзя закрыть без живого ключа; код корректно покрывает наиболее вероятный OpenAI-совместимый вариант.

**Фикс/проверка:** живой DeepSeek прогон со стримингом и долгим reasoning (>45 с); при необходимости расширить детектор (`payload.reasoning_content`, `delta.reasoning`, `message.reasoning_content`).

### ⚪ R10. C2: `OPEN_PANEL` отвечает `ok:true` оптимистично

**Файл:** `extension/background.js:382-394`.

`openPanelForTab` возвращает `true` сразу после вызова `sidePanel.open`, не дожидаясь Promise. Если Promise отклоняется, fallback открывается уже после ответа `{ok:true}`. Для текущего UI это не критично (вызывающий не использует результат для показа), но контракт сообщения неточен.

**Фикс:** либо отвечать `ok:true, deferred:true`, либо дожидаться Promise (но тогда нельзя терять gesture — вызов уже сделан синхронно, ждать можно после).

### ⚪ R11. B1: проверка package.ps1 покрывает `src/href`, но не CSS `url()`/`@import`

**Файл:** `extension/package.ps1:93-112`.

Сейчас payload явный, а HTML-ссылки проверяются; CSS-ассеты (`url(../icons/...)` и т.п.) не валидируются. Для текущего набора риск низкий, но проверка неполная. **Фикс:** дополнительно сканировать `*.css` на `url(...)`/`@import` или проверять staging после копирования на отсутствующие файлы.

### ⚪ R12. N3: мёртвые пресеты/URL сторонних провайдеров остаются в config/llm-client

**Файлы:** `extension/lib/config.js` (openai/anthropic/ollama presets), `lib/llm-client.js` (ветки провайдеров).

После фиксации DeepSeek эти ветки недостижимы из UI, но содержат внешние адреса и увеличивают поверхность для store-ревью «single purpose/least privilege». Не блокер беты; перед стором удалить или явно помечать как неактивные.

---

## Топ-5 действий

1. **R1 (M4):** вернуть per-task дефолты температуры и применять пользовательскую настройку только как явный override — иначе качество reply/summary/chat изменилось незаметно для пользователя.
2. **R2 + живой QA C2:** проверить `sidePanel.open` из меню/команды/плавающей кнопки на реальных Chrome/Edge, особенно popup-fallback с `tabId` и activeTab; при пустом `tab.url` сохранять/передавать ожидаемый контекст.
3. **R3:** расширить сверку перед вставкой (subject + from/selected message/thread), убрать «сиротское» сообщение в stale-chat.
4. **R4:** закрыть store-артефакты (privacy policy/data-use, 1280×800, обоснование optional-хостов) и провести живой DeepSeek + реальные почтовые аккаунты.
5. **R5/R6:** увеличить лимит metadata nonce-блока (все имена вложений) и сузить 400-fallback по тексту ошибки; это дешёвые правки, снижающие риск ложных ответов и лишних запросов.

---

## Осталось / что нельзя проверить здесь

- Живой `chrome.sidePanel`: `open()` из контекстного меню/команды/сообщения content script; поведение user gesture; popup-fallback на Chrome 114–115 и при отказе `open`.
- Chrome/Edge с реальным профилем: установка из zip, permission-промпты, service worker после сна, `storage.session`.
- Gmail/Outlook/Яндекс Почта/360: актуальные селекторы, вложения, picker/focus, `MAIL_CONTEXT_CHANGED`, композер/iframe/вставка.
- DeepSeek с ключом: `deepseek-flash`, `thinking`/`reasoning_effort`, SSE-формат и reasoning-дельты, 400-fallback, 402, тайминги; отсюда R6/R9.
- Store-требования M9 и a11y N1; M7/M8 (история/квоты, автотесты в репо) — вне задачи 0.2.9.

**Итог:** 0.2.9 — заметный шаг к бете: B1 и основные 🟠-фиксы закрыты, артефакт zip функционален. До беты — живые проверки C2/C4 и желательно R1/R3; до стора — M9 и очистка N3.
