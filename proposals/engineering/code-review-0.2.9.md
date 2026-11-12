# Повторное код-ревью «Почерк» 0.2.9 (проверка фиксов 0.2.8)

**Версия reviewed:** **0.2.9** (`manifest.json`, `content.js VERSION`, `extension/dist/pocherk-0.2.9.zip`).
**Дата:** 13.11.2026.
**Что смотрел:** полный код 0.2.9 (background.js, content.js, sidepanel.js, options.html/js, `lib/*`, `package.ps1`, manifest), zip-артефакт, изменения в `README.md`, `extension/README.md`, `proposals/engineering/architecture.md`, `УСТАНОВКА-И-ПРОВЕРКА.md`, а также новые store-артефакты `docs/privacy-policy.md`, `docs/store-listing.md`, `docs/CHROME-WEB-STORE.md`, `docs/store/*.png`. Отдельно сверял закрытие находок B1/C1/C2/C3/C4/M1–M6/M10 из `code-review.md` (0.2.8) и искал регрессии.
**Чем проверял:** `node --check` всех 9 JS; 12 unit-проверок `lib/*` на Node (недоверенные блоки, 400-fallback, таймауты, testConnection); stub-стенд service worker (chrome.* замокан) для C2/M2/M3 и кэша вкладок; `package.ps1` в песочнице `%TEMP%` (позитивный и негативный прогон); headless Edge 157 (загрузка unpacked из папки и из zip 0.2.9, рендер `options.html`/`sidepanel.html`, `?tabId=`); SHA256-сверка zip ↔ исходники; grep по eval/remote code/секретам/telemetry; визуальный просмотр store-скриншотов и замер их размеров.
**Актуальность:** код 0.2.9 стабилен с 00:44 (mtime), zip собран 00:44 и по SHA256 совпадает с исходниками (19 записей, `options.js` в корне). Документация и store-папка обновлялись **во время ревью** (mtime README/`docs/*` — 01:19–01:20); выводы по докам сделаны по финальному состоянию на момент проверки (~01:2x). Код расширения, существующий `code-review.md` и ассеты не изменялись; создан только этот файл.

---

## Вердикт

- **К бете:** **условно готово.** Все заявленные блокеры/критичные фиксы 0.2.8 в коде закрыты (B1, C1, M1–M6; C2/C3 — в основном; C4 — кодом, но без живого ключа). Новый блокер в коде не найден. Перед бетой надо закрыть регрессию кэша вкладок (R1), усилить проверку перед вставкой (R3) и подтвердить живьём sidebar/жесты (R2) и DeepSeek (C4). Обязательный живой QA (Gmail/Outlook/Яндекс 360, side panel, ключ) в этом окружении невозможен.
- **К публикации в Chrome Web Store / Edge Add-ons:** **пока нет.** Новые store-артефакты (privacy draft, листинг, гайд, 3 скриншота 1280×800, promo 440×280) — большой прогресс, но блокируют: **S1** — store-скриншот №1 показывает несуществующий функционал и другого провайдера (`gpt-4o-mini`); **S2** — в политике/листинге плейсхолдеры `[ЗАМЕНИТЕ]`, нет публичного URL, а описание «не читает переписку в фоне» неточно относительно кода; плюс не завершён живой QA (это честно отмечено и в `docs/CHROME-WEB-STORE.md`).

---

## Статус находок 0.2.8

| # | Находка 0.2.8 | Статус в 0.2.9 | Чем подтверждено |
|---|---|---|---|
| **B1** | zip без `options.js`; сборка не проверяла HTML-ссылки | ✅ **Исправлено** | zip 0.2.9: 19 записей, `options.js` в корне, SHA256 совпадает с исходниками; `package.ps1` позитивно собирает 19 файлов и **негативный прогон** без `options.js` падает с `HTML references missing files: options.html -> options.js`; headless Edge из распакованного zip: `options.html` выполняет JS (6 языков голоса, бейдж «доступен») |
| **C1** | `From`/вложения вне nonce и в system prompt | ✅ **Исправлено** | `prompts.js:127-141` — `sanitizeUntrusted` + отдельный `wrapUntrusted('поля письма: адресат и вложения')`; unit-тест: «IGNORE ALL RULES» отсутствует в `task.system`, все вхождения — внутри nonce-блоков, подмена `<<<КОНЕЦ:…>>>` вырезана |
| **C2** | `sidePanel.open` после `await`; popup терял вкладку | ⚠️ **В основном исправлено**, есть остаток R1/R2 | `openPanelForTab` теперь синхронный, `sidePanel.open` до первого await; popup получает `?tabId=…`, `GET_TAB` отдаёт целевую вкладку. Stub-стенд: open раньше `storage.set` в проверенных путях (context menu, AI_COPILOT_FROM_PAGE, команда); при rejection `windows.create` c `sidepanel.html?tabId=7`; `GET_TAB` для mail-вкладки `restricted:false`. Остались: кэш вкладок (R1) и холодный старт команды (R2) |
| **C3** | генерация по устаревшему контексту | ⚠️ **Частично**: генерация блокируется, вставка — с оговорками | `sidepanel.js:1611-1614, 1653-1656, 1516-1519` — при `stale` показывается toast, генерации нет; перед вставкой (`1302-1316`) сверяется тема. Остаток R3: сверка не работает при пустой теме и только по теме |
| **C4** | модель/`thinking`/`reasoning_effort` не подтверждены; ложный «успех» testConnection | ✅ **Кодом исправлено**, живого ключа нет | `llm-client.js:408-427` — при HTTP 400 один повтор без `thinking`/`reasoning_effort`/`temperature` + notice; `testConnection` (`527-537`) при отсутствии модели отдаёт `ok:false, code:'MODEL_NOT_FOUND'`. Unit-тесты 12/12 (модель есть/нет/401, тело первого и второго запроса). Живой прогон на api.deepseek.com по-прежнему не сделан |
| **M1** | 45-с таймаут ломал non-stream/thinking | ✅ **Исправлено** | `llm-client.js:316-323` — first-token таймер только при `stream`; `372-381` — `reasoning_content` снимает таймер. Unit-тест со шпионом таймеров: non-stream ставит только 90000 мс; stream — 45000 с последующей очисткой; reasoning-дельта тоже снимает |
| **M2** | холодный старт терял `requestPage` | ✅ **Исправлено** | `background.js:208-218` сохраняет `{kind:'page', requestPage:true}` в pending; `sidepanel.js:2114-2132, 2156-2159` поднимает флаг и запускает `explainPage()` после `renderChat`. Stub-стенд: pending сохранён/прочитан/очищен |
| **M3** | pending всплывал после `CONTEXT_PUSH` | ✅ **Исправлено** | `sidepanel.js:2070-2076` после push отправляет `CLEAR_PENDING_CONTEXT`; обработчик в `background.js:365-368`; проверено стендом |
| **M4** | температура в options ни на что не влияет | ✅ **Исправлено** (статически) | `sidepanel.js:1413-1414` применяет `state.settings.temperature` ко всем задачам; `options.html:89-91` добавлена честная подпись «в thinking-режиме может игнорироваться». Живьём не проверялось (нет ключа) |
| **M5** | degraded-fallback читал весь UI | ✅ **Исправлено** | Gmail: fallback ограничен `[data-message-id], .a3s, .adn.ads` и возвращает `null`, если ничего нет (`content.js:487-505`); Outlook: `document.body` больше не используется как `main` (`content.js:584-627`). Остаток: Outlook degraded читает весь reading-pane (M5-остаток, ⚪) |
| **M6** | observer на весь документ, мёртвый патч History API | ✅ **Исправлено** | `content.js:1430-1479`: observer на `[role=main]`/`main`, проверка `visibilityState`, дешёвый interval, добавлен Navigation API, **патч `history.pushState` удалён**. Остаток: если `[role=main]` нет, наблюдается `body` |
| **M10** | доки расходятся с кодом | ⚠️ **Частично** | `architecture.md:30-31, 53-56, 141, 154-155`, `extension/README.md:202` приведены к коду. Осталось: `README.md:130,134,163-165`, `УСТАНОВКА-И-ПРОВЕРКА.md:122` («thinking off»), а также store-listing/privacy (S2) |

**Регрессий в критичных механизмах не найдено:** nonce-обёртка и санитайзинг не ослаблены (unit); safe-render по-прежнему только textContent/DOM (новых `innerHTML` из данных нет); нет remote code/CDN/eval, нет телеметрии, `fetch` только в `lib/llm-client.js`; композер content.js не менялся; адаптеры Gmail/Outlook переписаны только в fallback-ветках; Яндекс-адаптер без изменений; версия согласована (manifest = content.js = zip = 0.2.9).

---

## Новые и остаточные находки

Легенда: 🔴 Блокер · 🟠 Критично · 🟡 Средне · ⚪ Нит.

### 🟡 R1. Регрессия C2: кэш активной вкладки в service worker может указывать на чужую/extension-вкладку

**Файлы:** `extension/background.js:23-31` (`rememberActiveTab`), `:326-340` (`GET_ACTIVE_TAB`), `:448-450` (`tabs.onUpdated`), `:231-246` (`commands`).

`tabs.onUpdated` запоминает **любую** обновившуюся вкладку, а не только активную/фокусированную:

```js
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) rememberActiveTab(tab);
});
```

Плюс `GET_ACTIVE_TAB` вызывает `rememberActiveTab(tab)` для любой вкладки, которую вернул браузер; в popup-fallback, если `GET_TAB` не удался, `GET_ACTIVE_TAB` вернёт **собственную extension-вкладку** popup-окна и закэширует её. Обработчика `chrome.tabs.onRemoved` нет, поэтому закрытая вкладка тоже остаётся в кэше.

**Почему важно:** `Ctrl+Shift+Y` в `commands.onCommand` (`background.js:231-246`) при наличии кэша открывает панель «без await» — но именно для этой вкладки. Если фоновая вкладка догрузилась (обычное дело), команда откроет панель в другом окне/привяжет её к чужой вкладке; после закрытия вкладки — к несуществующей; в fallback popup получит `tabId` extension-страницы и снова окажется без контекста (ровно та проблема, которую закрывал C2).

**Доказательство:** stub-стенд service worker (chrome.* замокан) воспроизвёл оба сценария:
- после `tabs.onUpdated` для фоновой вкладки `id=9` команда вызывает `sidePanel.open({tabId:9})` вместо активной `7`;
- после `GET_ACTIVE_TAB`, вернувшего popup-вкладку `id=50` (`chrome-extension://…`), команда вызывает `sidePanel.open({tabId:50})`.

**Фикс:**
```js
function rememberActiveTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  if (!/^https?:/i.test(tab.url || '')) return;      // не кэшируем chrome-extension/chrome://
  cachedActiveTab = { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || tab.active !== true) return;           // только активная вкладка
  if (changeInfo.status === 'complete' || changeInfo.url) rememberActiveTab(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (cachedActiveTab && cachedActiveTab.id === tabId) cachedActiveTab = null;
});
// GET_ACTIVE_TAB: rememberActiveTab(tab) — только если tab.active === true
```
Либо в `commands` вместо кэша открывать панель синхронно для текущего окна (`chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })`) и дать панели самой определить вкладку.

---

### 🟡 R2. C2-остаток: холодный старт команды и повторная попытка `sidePanel.open`

**Файлы:** `extension/background.js:231-246, 382-401, 128-151`.

- Если кэш пуст (service worker только что проснулся на `commands`), команда сначала делает `chrome.tabs.query(...)` и вызывает `openPanelForTab` уже в `.then` (`231-246`). Это снова открытие **после await** — тот же класс риска с user gesture, который закрывали фиксом C2; здесь он остался для редкого холодного старта. Аналогично `OPEN_PANEL` (`382-401`).
- В `openPanelForTab` (`128-151`) после синхронного вызова `chrome.sidePanel.open({tabId})` код сразу возвращает `true`; если промис отклонён, fallback создаёт popup, но **вторая опция** (`{windowId}`) уже не пробуется, хотя раньше перебирались обе. Popup-путь работает (проверено), но в 116+ можно было бы остаться в side panel, а не открывать окно.

**Фикс:** для команды не полагаться на async query — вызывать `sidePanel.open({windowId: chrome.windows.WINDOW_ID_CURRENT})` синхронно (панель сама возьмёт активную вкладку) либо гарантировать заполненный кэш через `onActivated`; при rejection `tabId`-варианта пробовать `windowId` до popup-окна. **Живой тест обязателен:** headless не воспроизводит user gesture.

---

### 🟡 R3. C3-остаток: проверка «то же письмо» перед вставкой не работает для degraded/пустой темы; в `sendChat` остаётся orphan-сообщение

**Файлы:** `sidepanel.js:1302-1316` (проверка перед вставкой), `:1381-1396` (`resolveMail`), `:1492-1519` (`sendChat`).

```js
const expected = String(state.context.mail.subject || '');
const actual = String(fresh.mail.subject || '');
if (expected && actual && expected !== actual) { /* предупреждение */ }
```
Если тема не извлеклась (degraded Gmail/Outlook/Яндекс, логин-экран — `subject` может быть пустым), условие **не срабатывает**, и вставка проходит без сверки. Если темы совпадают («Re: договор»), но пользователь переключился на другое письмо с той же темой — тоже не поймает. Сверка идёт только по теме, без отправителя времени/`focusIndex`.

Отдельно: `sendChat` сначала добавляет сообщение пользователя в сессию и DOM и очищает поле ввода (`1495-1504`), затем вызывает `resolveMail` и при `stale` делает `return` (`1516-1519`) — в чате остаётся вопрос без ответа (и он сохранится в историю).

**Фикс:**
1. Сравнивать не только тему, но и стабильный ключ сообщения (например, `from|time`, как `mailSelectionKeyFor`), а при отсутствии надёжного ключа — не вставлять автоматически, а копировать в буфер с предупреждением «не удалось сверить письмо».
2. В `sendChat` разрешать контекст до `addMessage`, либо удалять добавленное сообщение/восстанавливать input при `stale`.

---

### 🟠 S1. Store-скриншот №1 и тексты листинга показывают функционал, которого нет в 0.2.9

**Файлы:** `docs/store/screenshot-1-1280x800.png`, `docs/store-listing.md:25-33`, `docs/CHROME-WEB-STORE.md:95-104`.

Скриншот №1 (визуально проверен, 1280×800) — это не текущее расширение, а старый макет:
- в шапке панели: «Ключ пользователя · **gpt-4o-mini**» — в 0.2.9 провайдер/модель жёстко DeepSeek flash, панель показывает «DeepSeek · flash» (`sidepanel.js:263-265`, `config.js:229-257`);
- кнопка «**Черновики** Ctrl+Shift+.» в Gmail — в 0.2.9 такого toolbar-элемента нет (есть плавающая кнопка «Почерк» и quickbar «Объяснить страницу / Ответить на письмо / Сводка письма»);
- «3 варианта: **короткий · деловой · тёплый**» — код и demo генерируют **формальный / нейтральный / краткий** (`lib/prompts.js:144-162`, `lib/demo.js:48-106`); те же тональных названия повторены в `store-listing.md:28` и `README.md:20-21,32-33`;
- «Вставить / **Править / Ещё**», баннер «**Черновик вставлен „Почерком“ — письмо не отправлено**», блок «Почему так: …» — этих элементов в UI 0.2.9 нет.

Требования CWS: скриншоты должны достоверно отражать функционал расширения; несуществующие экраны/провайдер — риск отказа/снятия листинга. `docs/CHROME-WEB-STORE.md:97` при этом утверждает «сгенерированы из реальных макетов/скриншотов», что для №1 неверно.

**Фикс:** перегенерировать screenshot-1 из реального `sidepanel.html` 0.2.9 (демо-режим или реальный ключ) по образцу screenshot-2/3, убрать `gpt-4o-mini` и несуществующие элементы; привести описание и `store-listing` к фактическим тональностям и названиям кнопок. Перед этим исправить N1 (демо-подпись внутри варианта), иначе она попадёт и в новый скриншот.

---

### 🟡 S2. Privacy policy и обоснование прав: плейсхолдеры + два неточных утверждения

**Файлы:** `docs/privacy-policy.md:4,24-25,60-61,84`; `docs/store-listing.md:19-20,72-73,87`; `docs/CHROME-WEB-STORE.md:14-24`.

1. **Плейсхолдеры и URL.** В политике `[ЗАМЕНИТЕ: ИП/ФИО…]`, `[ЗАМЕНИТЕ: e-mail]` (строки 4, 84), в листинге `[ЗАМЕНИТЕ e-mail]`, `[URL опубликованной политики]` (19-20, 87); публичного HTTPS-URL нет — в `CHROME-WEB-STORE.md:19` честно стоит ❌. Без этого CWS не пропустит.
2. **«Не читает переписку в фоне»** (`privacy-policy.md:24-25`) и «читать открытое письмо при вашем действии» (`:60-61`) неточно: декларативный content script на 20 доменах почты запускается сам (`manifest.json:43-73`), наблюдает DOM и **локально** извлекает тред для контекста/`MAIL_CONTEXT_CHANGED` (`content.js:188-213, 1430-1479, 1543-1545`) без отдельного клика. Наружу данные уходят только при генерации, но политика должна это проговаривать («локально читает открытое письмо, чтобы показать контекст; отправка — только по вашему действию»), иначе data-use disclosure расходится с фактическим поведением (риск ревью/жалоб).
3. **Обоснование прав** (`store-listing.md:72-73`): «12 доменов, 20 зеркал» не соответствует манифесту (20 match-паттернов: 4 базовых хоста + 16 Яндекс-зеркал); «адрес провайдера указал пользователь» и `http://localhost/*`/`127.0.0.1/*` — устарели (провайдер фиксирован, Ollama-пресет недостижим); «кнопка „Черновики“» в описании не соответствует фактическому лончеру «Почерк».

**Фикс:** заполнить плейсхолдеры, опубликовать политику (GitHub Pages/сайт), переписать формулировки про локальное чтение письма и обоснование optional-хостов (широкий `https://*/*` нужен для чтения произвольной страницы по кнопке; localhost либо убрать из манифеста, либо явно обосновать), выверить «12 доменов»/«20 зеркал» по манифесту.

---

### 🟡 M10-остаток. Документация: часть утверждений всё ещё расходится с кодом

**Файлы:** `README.md:20-21,32-33,130,134,163-165`; `УСТАНОВКА-И-ПРОВЕРКА.md:122`; `extension/README.md` и `architecture.md` в основном уже исправлены.

- `README.md:130` — «модель … пользователю не показывается», но панель показывает `DeepSeek · flash` (`sidepanel.js:263-265`).
- `README.md:134` — «в UI показывается только „Соединение работает“»: теперь при отсутствии модели UI показывает ошибку «модель недоступна» (`llm-client.js:527-537`, `options.js:267-269`) — это лучше, но текст устарел.
- `README.md:163` — «опциональные хосты только для адреса провайдера»: фактически `https://*/*` нужен для чтения произвольной страницы по кнопке (`sidepanel.js:364-392`), localhost-хосты не используются.
- `README.md:164` — «BYOK: адрес/модель/ключ вводит пользователь»: адрес/модель/провайдер жёстко зафиксированы (`config.js:229-257`).
- `README.md:165` — «Стор одобряет» — недоказуемое утверждение до прохождения ревью.
- `УСТАНОВКА-И-ПРОВЕРКА.md:122` — «thinking **off**», тогда как код шлёт `thinking: enabled` (`llm-client.js:119-122`) и остальные доки это уже исправили.
- Названия тональностей «короткий/деловой/тёплый» в README/store-listing/screenshot-1 не совпадают с фактическими «формальный/нейтральный/краткий» (S1).

**Фикс:** синхронизировать эти строки с кодом; для стор-ревью важнее точность, чем полнота.

---

### ⚪ N1. (Не исправлено, не входило в список) демо-подпись попадает в тело 3-го варианта

**Файлы:** `lib/demo.js:199-212`; `sidepanel.js:1461-1471`.

`demoStream` добавляет `— Демо-ответ без обращения к модели…` после вариантов, а парсер вариантов считает это продолжением третьего варианта. На store-скриншоте №2 эта строка видна внутри карточки «3 краткий». Не блокер, но портит UI и скриншоты. Фикс: показывать демо-дисклеймер отдельным DOM-блоком (`meta.demo` в `finishStreaming`) либо обрезать хвост перед `parser.finish()`.

### ⚪ N2. Мелкие остатки M5/M6

- Outlook degraded по-прежнему отдаёт весь reading-pane (`content.js:613-627`) — лучше, чем `document.body`, но может включать служебные элементы; при желании ограничить `[data-automationid="messageBody"]`.
- Observer падает на `document.body`, если `[role=main]` не найден (`content.js:1449-1455`); на обычных mail-страницах main обычно есть, но fallback стоит ограничить `[role=main]`/`.mail-*` контейнером.
- Извлечение треда по-прежнему вызывается на мутации в main с debounce 500 мс — для Gmail с активными счётчиками это заметная работа; можно поднять debounce до 1–2 с.

---

## Что проверено инструментально (0.2.9)

1. **Синтаксис:** `node --check` — OK для всех 9 JS (`background`, `content`, `sidepanel`, `options`, `lib/config`, `lib/demo`, `lib/llm-client`, `lib/prompts`, `lib/style-profile`).
2. **Версии/zip:** manifest 0.2.9, `content.js VERSION = '0.2.9'`, zip-manifest 0.2.9; zip = **19 записей**, `manifest.json` и `options.js` в корне, forward slashes; SHA256 всех файлов zip совпадает с исходниками, лишних файлов (tools/dist/README/секретов) нет.
3. **Сборка (`package.ps1` в `%TEMP%`-копии):**
   - позитивный прогон: exit 0, «Entries: 19», `options.js` присутствует;
   - негативный прогон (удалён `options.js`): exit 1, `HTML references missing files: options.html -> options.js` — защита B1 работает.
4. **Headless Edge 157 (unpacked):**
   - из папки `extension/`: `options.html` — JS выполнен (6 `<option>` языков голоса, бейдж «доступен»); `sidepanel.html` — без init-ошибки, «Демо-режим · без ключа»; `sidepanel.html?tabId=123456` рендерится без падения;
   - из распакованного **zip 0.2.9**: `options.html` — JS выполнен (6 option, бейдж «доступен»), `sidepanel.html`/`?tabId=` — без init-ошибок. Это закрывает B1 на артефакте.
5. **Unit-проверки `lib/*` (12/12 PASS):** nonce-санитайзинг; C1 (evil `From` не в `system`, все вхождения внутри nonce, метка «поля письма: адресат и вложения», подмена маркера вырезана); фокус/история/variants; schema-3/DeepSeek/hosts; style learning; testConnection (модель отсутствует → `MODEL_NOT_FOUND`, модель есть → ok, 401 → `AUTH`); HTTP 400 fallback (второе тело без `thinking`/`reasoning_effort`/`temperature`, notice+token+done); M1 non-stream не ставит 45000, streaming ставит и снимает, reasoning снимает.
6. **Stub-стенд service worker (chrome.* замокан):** open до `storage.set` в context-menu/лаунчере; `requestPage` сохраняется и `GET_PENDING_CONTEXT` очищает; `CLEAR_PENDING_CONTEXT`; `GET_TAB` mail-вкладка `restricted:false`, `NO_TAB` для несуществующей; popup-вкладка помечается restricted; async rejection `sidePanel.open` → `windows.create` c `sidepanel.html?tabId=7`; `AI_COPILOT_FROM_PAGE` отвечает `{ok:true}` и пишет pending. В том же стенде **воспроизведены R1** (кэш от фоновой/extension-вкладки) — 9/10 сценариев PASS, единственный FAIL оказался ошибкой самого теста (не дождался async `onActivated`; при разборе логика `rememberActiveTab` подтверждена).
7. **grep-аудит:** нет `eval`/`new Function`/`document.write`/внешних `<script src>`/CDN/`sendBeacon`/telemetry; `fetch` только в `lib/llm-client.js` (± `/models`, `/api/tags`, chat); нет `chrome.storage.sync`; секретов/`sk-` нет; `innerHTML` только для статических SVG; `content.js` без `innerHTML`/eval.
8. **Store-артефакты:** `docs/store/` — 3 скриншота 1280×800 + promo 440×280 (размеры проверены); screenshot-2 — реальная панель 0.2.9 (демо), screenshot-3 — реальные настройки 0.2.9; screenshot-1 — макет с несуществующими элементами (S1); `docs/privacy-policy.md`, `docs/store-listing.md`, `docs/CHROME-WEB-STORE.md` прочитаны и сверены с кодом.
9. **Сверка изменений 0.2.8→0.2.9:** content.js изменялся только в fallback-ветках Gmail/Outlook и launcher-observer (композер/Яндекс-адаптер без изменений); prompts — только C1-метаданные; llm-client — таймеры/fallback/testConnection; background — sidePanel/кэш/pending; sidepanel — popup/stale/temperature/notice; options.js, config.js, style-profile.js, demo.js, sidepanel.html/css, options.css не менялись.

---

## Что нельзя проверить без живого браузера/аккаунта/ключа

- **User gesture и side panel:** вызовы `sidePanel.open` из commands/context menu/лаунчера синхронно (R2), особенно холодный старт service worker; поведение side panel в Edge; открытие popup-окна на 114–115; фактический `cachedActiveTab` после реальных переключений/закрытия вкладок (R1).
- **Почта:** Gmail/Outlook Web/Яндекс Почта/Яндекс 360 на живых аккаунтах — актуальные селекторы, picker/focusIndex, `MAIL_CONTEXT_CHANGED` при SPA, вставка в композер (contenteditable/iframe), Ctrl+Z, degraded-режим, отправка (её нет).
- **DeepSeek:** существует ли `deepseek-flash`, принимаются ли `thinking`/`reasoning_effort` (400-fallback проверен только unit-тестом с фейковым fetch), реальный SSE/reasoning, 401/402/429, живой `testConnection` с ключом и отсутствующей моделью.
- **Голос** (микрофон, Web Speech API), **a11y** (скринридер, фокус, контраст), реальные квоты `chrome.storage.local` при большой истории.
- **Store:** фактическое ревью CWS/Edge и поведение их валидаторов; публикация privacy policy URL; визуальная проверка скриншотов именно в карточке магазина (мы видели только PNG-файлы).

---

## Топ-5 до беты

1. **R1:** исправить кэш `cachedActiveTab` (только активные http(s)-вкладки, `onRemoved`, не кэшировать `GET_ACTIVE_TAB` из popup) — это регрессия от фикса C2, ломает `Ctrl+Shift+Y`.
2. **R2 + живой QA side panel:** прогнать в реальном Chrome/Edge открытие из иконки, `Ctrl+Shift+Y` (в т.ч. после фоновой загрузки вкладок), контекстного меню, лаунчера и popup-fallback; при необходимости вызывать `sidePanel.open({windowId})` синхронно.
3. **R3:** усилить проверку перед вставкой (не только тема, не пропускать при пустой теме) и убрать orphan-сообщение в `sendChat` при stale.
4. **C4 live:** один прогон DeepSeek с реальным ключом: `/models`, `deepseek-flash`, `thinking`/`reasoning_effort`, 400-fallback, 401/402; проверить, что «модель недоступна» в testConnection не остаётся зелёной.
5. **M10 + N1:** синхронизировать остатки docs (README/УСТАНОВКА/store-listing), убрать демо-подпись из тела варианта — иначе она попадёт в store-скриншоты и путает QA.

## Топ-3 до публикации в сторах

1. **S1:** перегенерировать screenshot-1 из реального UI 0.2.9, убрать `gpt-4o-mini`/«Черновики»/несуществующие кнопки/баннеры и привести тональности в листинге к фактическим (после N1).
2. **S2:** заполнить плейсхолдеры в privacy policy/store-listing, опубликовать публичный HTTPS-URL, исправить формулировки о локальном чтении письма, обосновать `https://*/*`/убрать неиспользуемые localhost и выверить «12 доменов / 20 зеркал».
3. **Живой QA + кабинет:** Gmail/Outlook/Яндекс 360 + DeepSeek-ключ + голос, затем заполнить Privacy practices/data-use, подтвердить Limited Use и remote code = No, загрузить zip 0.2.9 (19 файлов, `options.js` на месте) и пройти ревью.

---

## Что сделано хорошо в 0.2.9

- B1 закрыт не «заплаткой», а системно: `options.js` в payload + проверка всех локальных `src/href` в HTML; негативный тест сборки это доказывает.
- C1 закрыт по правильной модели угроз: DOM-метаданные санитизируются и уходят отдельным nonce-блоком, а не в system; unit-тест на инъекцию воспроизводит атаку и подтверждает защиту.
- C2/C3/M1/M2/M3 закрыты в коде и проверены стендами; `sidePanel.open` теперь вызывается синхронно, popup получает `tabId` и `GET_TAB`, pending больше не теряется/не всплывает, 400-fallback и таймеры работают.
- Store-направление сдвинулось: privacy draft, store-listing, пошаговый CWS-гайд, 3 скриншота 1280×800 и promo есть; в `CHROME-WEB-STORE.md` честно перечислены незакрытые пункты (URL политики, живой QA).
