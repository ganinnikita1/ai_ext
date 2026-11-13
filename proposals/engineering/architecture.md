# Почерк — техническая архитектура MVP-расширения

Документ для инженерного ревью, стора и следующего шага разработки. Кодовый скелет —
`browser-ai-copilot/extension`, продуктовый концепт — `browser-ai-copilot/proposals/inventor/concept.md`.
Название продукта: **Почерк**, версия скелета 0.2.12.

## 1. Границы этого этапа

Скелет доказывает: расширение грузится unpacked в Chrome и Edge, читает страницу/письмо на живом DOM,
делает BYOK-вызов со стримингом и вариантами ответа. Своей серверной части нет; UI-превью (headless,
заглушка `chrome.*`) — в `proposals/engineering/screenshots/`.

## 2. Совместимость Chrome и Edge

Кодбейс общий: Manifest V3 + WebExtensions-совместимый API Chromium. Отдельных сборок нет, различия
закрыты feature detection, а не ветвлением по бренду.

| Аспект | Chrome | Edge | Что делает код |
| --- | --- | --- | --- |
| Side Panel API | `sidePanel` с Chrome 114, `sidePanel.open()` с Chrome 116 | Side panel API поддерживается тем же Chromium-слоем (документация Microsoft: `side_panel` + `sidePanel`) | `minimum_chrome_version: 114`; если `sidePanel.open` нет — фолбэк на отдельное окно `sidepanel.html?tabId=…` (Chrome 114–115), контекст берётся по `GET_TAB` |
| Установка | Chrome Web Store + unpacked | Microsoft Edge Add-ons + unpacked | Один zip (`package.ps1`) подходит обоим сторам |
| Магазины | Chrome Web Store: $5, ревью обычно 1–4 недели | Edge Add-ons: бесплатно, ревью обычно 1–7 рабочих дней; Edge **также ставит расширения из Chrome Web Store** | Публикуем в оба; политики почти совпадают (single purpose, data disclosure) |
| Обновления | автообновление из CWS | автообновление из Edge Add-ons; политики `ExtensionInstallForcelist` в enterprise | Версию в `manifest.json` поднимаем только вперёд |
| `commands` | `Ctrl+Shift+Y` | тот же Chromium-механизм; конфликтующие сочетания пользователь меняет в `edge://extensions/shortcuts` | Сочетание — suggested, не гарантированное |
| Web Speech API | `webkitSpeechRecognition`, облако Google | `webkitSpeechRecognition`, облако Microsoft | Feature detection + понятная деградация |
| `chrome.storage.session` | есть с Chrome 102 | есть | Используется для «отложенного контекста», с fallback в память SW |
| Стор | `chrome.runtime.getManifest().version` одинаков | там же | `package.ps1` берёт версию из манифеста |

Минимальные версии: Chrome/Edge **114+** для боковой панели. `sidePanel.open()` — 116+; на 114–115
открытие из меню/команды деградирует в popup-окно с явным `tabId` (контекст берётся через `GET_TAB`). Кэш активной вкладки — только активные http(s)-вкладки, очищается `tabs.onRemoved`; extension-вкладки не кэшируются.
`sidePanel.open()` вызывается синхронно до первого await; fallback-окно получает tabId в URL. Опциональные хосты и `chrome.permissions.request` работают одинаково.

Что проверить руками на реальном Edge (нельзя проверить без браузера):

1. Регистрация `side_panel` в `edge://extensions` → «Открыть боковую панель» (Side panel).
2. `sidePanel.setPanelBehavior({openPanelOnActionClick:true})` — открывается ли панель по клику на иконку.
3. `sidePanel.open()` из контекстного меню и по `Ctrl+Shift+Y` — панель должна открыться в текущем окне.
4. Контекстное меню на выделении: текст доезжает до панели (`CONTEXT_PUSH`).
5. `chrome.scripting.executeScript` на обычной странице (activeTab) и на Gmail/Outlook.
6. Чтение треда и вставка в композер на `outlook.live.com`/`outlook.office.com` и на `mail.yandex.ru`
   (вёрстка отличается; для Яндекса — best-effort, см. раздел 7).
7. Плавающая кнопка «Почерк» на почте: не перекрывает кнопку «Написать», не исчезает при SPA-навигации.
8. `chrome.permissions.request` для домена провайдера и `chrome.permissions.remove` в настройках.
9. Web Speech API (`ru-RU`, автостоп, запрет микрофона) и `chrome.storage.local` в Edge-профиле.

## 2.1. Обработка — DeepSeek (модель зафиксирована)

- Base URL `https://api.deepseek.com`, чат — `POST /chat/completions` в OpenAI-формате. Провайдер, адрес и
  модель **зафиксированы в коде**: `deepseek-flash`. Настройки дают только API-ключ и стриминг — выбрать
  другую модель/провайдера/Base URL нельзя. `normalizeSettings` (schema 3) принудительно
  мигрирует старые настройки (openai/anthropic/ollama, другая модель) к фиксированному профилю.
- Reasoning включён на среднем уровне: тело запроса `"thinking": {"type": "enabled"}` +
  `"reasoning_effort": "medium"`. Параметр отправляется только DeepSeek; при HTTP 400 с текстом про неизвестное
  поле — один повтор без thinking/reasoning_effort и без temperature (на invalid model не повторяем).
  Температура не вынесена в UI: задачи используют собственные проверенные значения.
- Проверка соединения: `GET /models` с `Authorization: Bearer …`; при отсутствии модели — `ok:false` с предупреждением. Баланс не запрашивается; HTTP 402 → `BALANCE` (без цифр баланса).
- CORS: extension page делает `fetch` с выданным optional host permission на `api.deepseek.com`,
  CORS-заголовки не требуются. Приём запроса провайдером проверен статически — нужен прогон с ключом.
- Ключ вводится в одном поле настроек и хранится только в `chrome.storage.local`; в UI нет цен, текстов
  про провайдера и выбора моделей. Ключ получают на `platform.deepseek.com/api_keys`.
- Внутренние пресеты других провайдеров остаются в коде как задел на будущее, но недостижимы из UI:
  `normalizeSettings` всегда возвращает фиксированный DeepSeek-профиль.

## 3. Разрешения: least privilege и обоснование

Установочные permissions: `storage`, `activeTab`, `scripting`, `sidePanel`, `contextMenus`.
`host_permissions` — пустой массив. Опциональный хост: `https://*/*` (чтение страниц по кнопке и вызов
DeepSeek; localhost-хосты не используются, провайдер зафиксирован).

| Разрешение | Зачем | Почему не шире | Формулировка для ревью |
| --- | --- | --- | --- |
| `storage` | настройки, ключ, история чатов, профиль стиля | не используется `sync`, данные не покидают профиль | «Хранит настройки и историю локально» |
| `activeTab` | чтение текущей вкладки по действию пользователя (иконка/команда/меню) | нет постоянного доступа ко всем вкладкам | «Доступ к странице только после действия пользователя» |
| `scripting` | инжект `content.js` по требованию на произвольные страницы | инжектим только по клику, не на все сайты | «Извлекает текст активной страницы по запросу» |
| `sidePanel` | UI в боковой панели | — | «Показывает интерфейс ассистента» |
| `contextMenus` | пункты «Спросить AI про выделенное» и «Почерк: разобрать страницу» | — | «Добавляет два пункта меню» |
| `optional_host_permissions` | чтение произвольной страницы по кнопке (activeTab/scripting) и fetch к DeepSeek | `https://*/*` нужен для инъекции на сайт по действию пользователя; localhost не используется | «Доступ к сайту только после действия пользователя; запросы к DeepSeek» |
| `content_scripts` (20 доменов) | плавающая кнопка и чтение открытого письма **без** клика | Gmail, Outlook Web (3) и Яндекс Почта/360 (16 зеркал `mail.yandex.*`, `mail.360.yandex.*`); `<all_urls>` нет | «Читает открытое письмо на Gmail, Outlook Web и Яндекс Почте» |

Компромисс: декларативный контент-скрипт на почте даёт предупреждение установки о доступе к этим
доменам, зато кнопка появляется сразу. Альтернатива — инжект по требованию на каждый заход — ломает UX
и всё равно требует хостов. Для стора это объяснимо и ограничено двадцатью доменами
(Gmail, Outlook Web, зеркала Яндекс Почты и Яндекс 360).

## 4. Компоненты и потоки данных

```
                         ┌──────────────────────────── sidepanel.html/js ───────────────────────────┐
                         │ чат, история, варианты, вставка, обучение стилю, голос (Web Speech API)  │
                         │ lib/llm-client.js → fetch(SSE / NDJSON) → провайдер пользователя         │
                         └───────────────▲──────────────────────────────┬───────────────────────────┘
                                         │ runtime.sendMessage           │ tabs.sendMessage
                                         │ (GET_ACTIVE_TAB, ENSURE_      │ (GET_PAGE, GET_MAIL,
                                         │  CONTENT, CONTEXT_PUSH,       │  GET_SELECTION, INSERT_TEXT,
                                         │  GET_PENDING_CONTEXT)         │  GET_COMPOSER)
┌──────────────────────┐      contextMenus/commands/action      ┌───────▼──────────────────────────┐
│ browser action,      │ ───────────────────────────────────────▶│ background.js (service worker)   │
│ commands, context    │                                         │ sidePanel, меню, инжект, маршрут │
│ menu                 │                                         │ chrome.storage.session (pending) │
└──────────────────────┘                                         └───────▲──────────────────────────┘
                                                                         │ activeTab + scripting
                                                         ┌───────────────▼──────────────────┐
                                                         │ content.js (страница, Gmail,     │
                                                         │ Outlook): извлечение текста,     │
                                                         │ тред, композер, плавающая кнопка │
                                                         └───────────────▲──────────────────┘
                                                                         │ никто не отправляет письмо
                                                                  ┌──────┴──────┐
                                                                  │ веб-страница│
                                                                  └─────────────┘
```

Поток «ответ на письмо»: панель → `GET_ACTIVE_TAB` → `ENSURE_CONTENT` → `GET_MAIL` (перечитывается перед каждым действием; content script шлёт `MAIL_CONTEXT_CHANGED` при смене открытого письма, debounce 1.5 с) →
`lib/prompts.buildReplyTask` (тред оборачивается как недоверенные данные) → `llm-client` →
стрим → парсер вариантов → карточки → `INSERT_TEXT` в композер → пользователь правит и отправляет. Кнопка панели — «Спросить» (не отправка письма); вставка идёт только выбранным вариантом; демо-дисклеймер показывается отдельным UI-notice и не попадает в тело.
Промпты: content script отдаёт `openMessage` (открытое письмо) и `threadMessages` (все сообщения reading pane);
`formatMailForPrompt({scope:'open'|'thread'})` для open берёт только `openMessage`, для thread — все
`threadMessages`; reply всегда open; summary/chat scope задаёт кнопка; анти-галлюцинации (Адресат/Вложения) сохранены.

### Формат сообщений

Все сообщения — объекты с полем `type`; для контент-скрипта обязателен `target: "content"`.
Ответы асинхронные (`sendResponse`), ошибки — `{ok:false, reason}`.

```
sidepanel → background : {type:"GET_ACTIVE_TAB"} → {ok, tab:{id,url,title,isMail,restricted}}
sidepanel → background : {type:"ENSURE_CONTENT", tabId} → {ok, injected, isMail, reason}
sidepanel → background : {type:"GET_PENDING_CONTEXT", clear} → {ok, context|null}
background → sidepanel : {type:"CONTEXT_PUSH", context} | {type:"CONTEXT_PUSH", requestPage:true}
content → background   : {type:"AI_COPILOT_FROM_PAGE", payload:{kind,text,mail,page,site}}
sidepanel → content    : {target:"content", type:"GET_PAGE"|"GET_MAIL"|"GET_SELECTION"|
                          "INSERT_TEXT"|"GET_COMPOSER"|"PING"}
```

Storage: `settings` (провайдер, base URL, модель, ключ, max tokens, streaming, тема, голос),
`styleProfile` (prefs + до 30 пар «черновик→правка» + выведенные правила), `chatSessions` (до 20 чатов),
`pendingContext` в `storage.session` (живёт до перезагрузки браузера).

Ошибки нормализованы в `LLMError` (`NO_KEY`, `NO_PERMISSION`, `AUTH`, `RATE_LIMIT`, `NOT_FOUND`, `TIMEOUT`,
`NETWORK`, `SERVER`, `BAD_RESPONSE`, `ABORTED`); панель показывает заголовок, подсказку и кнопки
«Повторить»/«Разрешить домен»/«Настройки». Ретраи — только до первого токена (2 повтора = до 3 попыток), стрим не переигрывается.

## 5. Приватность и безопасность

- **BYOK.** Ключ вводит пользователь, он лежит в `chrome.storage.local` (не `sync`). Ключ виден только
  странице настроек (с маскированием) и клиенту; в логи, историю и экспорт профиля он не попадает.
  Пользователь может отозвать доступы к доменам одной кнопкой.
- **Что уходит провайдеру:** текст вопроса, извлечённый контент (страница — до 14 000 символов, письмо —
  до 12 000, выделение — до 4 000), системный промпт с профилем стиля. По умолчанию — DeepSeek
  (`api.deepseek.com/chat/completions`, адрес и модель зафиксированы). Размер ограничен
  на клиенте. Никакой телеметрии, аналитики, собственного бэкенда нет.
- **Prompt injection.** Всё, что пришло из DOM, оборачивается `<<<ДАННЫЕ:<nonce>>> … <<<КОНЕЦ:<nonce>>>`
  с криптослучайным nonce на каждый запрос. Внутри данных вырезаются `<<<`/`>>>`, control/bidi.
  Имя отправителя и имена вложений идут ОТДЕЛЬНЫМ nonce-блоком и не выводятся в system-инструкции;
  reply получает «Адресат/Вложения» только внутри блока. Системный промпт запрещает выполнять
  инструкции из данных, раскрывать промпт, отправлять письма; при подозрительной инструкции — сообщить.
  **В коде нет пути автоотправки** — только `INSERT_TEXT`; injection не может отправить письмо.
- **XSS в side panel.** Ответ модели никогда не вставляется как HTML: только `textContent`/DOM-узлы,
  минимальный безопасный рендер (абзацы, списки, `<pre>`, `**bold**`), ссылки создаются с проверкой
  схемы и `rel="noopener noreferrer"`. Данные страницы не рендерятся в панели вообще — только текст
  контекста в системном промпте.
- **Нет remote code.** Все скрипты локальные, `<script src="https://…">`, CDN, eval и `new Function`
  отсутствуют. CSP extension pages: `script-src 'self'; object-src 'self'; base-uri 'none'`.
  Сторонние шрифты не подключаются — только системные.
- **Минимизация доступа.** Обычные страницы читаются только с `activeTab` (после клика по иконке/меню/
  команде). Постоянный доступ — только к доменам веб-почты, и только для кнопки и чтения.
- **Срок жизни данных.** История и примеры стиля — до удаления; «Сбросить всё» чистит `storage.local` и отзывает хосты. Голос обрабатывается браузером, аудио расширение не получает.

## 6. Голосовой ввод

Реализация — Web Speech API в side panel, без внешних скриптов и собственного STT.

- **Как работает:** клик по микрофону → `recognition.start()`; `lang` из настроек (`ru-RU` по умолчанию);
  `continuous` + `interimResults`, промежуточный текст сразу в поле ввода. Автостоп по тишине — 2,6 с
  с момента последнего результата, плюс лимит 60 с. Финальный текст подставляется в поле; опционально
  (`voice.autoSend`, по умолчанию off) вопрос отправляется сам. При `onend` — до 4 перезапусков.
- **Приватность:** в Chromium Web Speech API отправляет аудио в облако вендора (Google в Chrome,
  Microsoft в Edge): аудио покидает устройство, но расширение не имеет к нему доступа и ничего не хранит.
  Голос можно выключить в настройках — это указано в README и options.
- **Разрешения:** манифест-разрешения не нужны; браузер запрашивает микрофон для origin
  `chrome-extension://…` при первом использовании. Запрет → `not-allowed` и понятное сообщение.
- **Ограничения:** нужен интернет; Web Speech API нет в Firefox/Safari; в корпоративных политиках сервис
  может быть отключён (`service-not-allowed`); фоновое распознавание не поддерживается.
- **Альтернатива на будущее:** `MediaRecorder` + собственный STT (Whisper API по BYOK или локальный
  сервер) — контроль приватности и цены, но отдельный UX; в MVP сознательно не тащим.

## 7. Интеграция с почтой: DOM сейчас, API позже

**Сейчас (MVP):** `content.js` читает открытый тред через DOM. Gmail: `div[role="main"]`, карточки
`div.adn.ads` / `[data-message-id]`, тело `.a3s` (цитаты и подписи вычищаются из клона). Outlook Web:
несколько стратегий селекторов (`[id^="UniqueMessageBody"]`, `[data-automationid="messageBody"]`,
`div.allowTextSelection`), при неудаче — «упрощённое чтение» всего региона и флаг `degraded`.
Вставка — `execCommand('insertText')` → `insertHTML` → `textContent` (для пустого contenteditable);
если не вышло — копирование в буфер и явная просьба вставить вручную. Это хрупко: вёрстка меняется
без предупреждения, селекторы придётся поддерживать по версиям, а часть писем (iframe, canvas,
PDF-вложения, «показать скрытую часть») недоступна.

**Яндекс Почта и Яндекс 360 (best-effort).** Домены `mail.yandex.*` (8) и `mail.360.yandex.*` (8)
добавлены в `content_scripts` (20 доменов почты всего), `WEBMAIL_HOSTS` и `detectSite()` (site = `yandex`).
Приоритет чтения: только **область чтения открытого письма** (`.mail-MessageView`/`.mail-Thread`/`.mail-Content`/`[role="main"]`), не `document.body`/layout; внутри — BEM-карточки `.mail-Message`/`.mail-Thread-Message` с
`.mail-Message-Body`; сайдбары/списки (`.mail-ThreadsList`, `.mail-MessageList`, `[class*="Sidebar"]`, `[class*="Snippet"]`, `[class*="related"]`, `[role="complementary"]`) исключаются из `openMessage`/`threadMessages`/attachments/темы; сниппеты отбрасываются; если видно одно письмо — threadMessages = [оно]. Сообщения ниже вьюпорта читаются, если уже отрисованы в DOM reading pane; свёрнутые/ленивые — только после «Открыть всю переписку»/прокрутки.
Тема — `.mail-Thread-Subject`/`.mail-Message-Subject`/`h1`/`h2`/title;
отправитель — `.mail-Message-Sender`/`.mail-Message-Header-From`/`[class*="Sender"]`/`mailto` (display name + email, без аватара); получатель — «Кому:»; время — `.mail-Message-Date`/`time`/дата в шапке;
тело — `.mail-Message-Body`; вложения — `.mail-Message-Attachments`/`[class*="Attachment"]`/`[download_url]` (только имена файлов); `cleanYandexBody` вырезает цитаты (blockquote, вложенные `.mail-Message`/`.mail-Message-Body`, «… пишет:»), но сохраняет блок «Пересылаемое сообщение». Если темы или отправителя нет —
`degraded: true`. Вставка: `.mail-Compose-Body` — приоритетный селектор композера; если композер в iframe,
`INSERT_TEXT` возвращает `COMPOSER_IN_IFRAME`, панель копирует текст в буфер. Логин-экран не отдаётся как
«письмо». Кнопка (right 18 / bottom 92) переустанавливается при SPA-навигации. Проверено на синтетическом
DOM для обоих UI; авто-инжект в branded-Chrome отключён (`--load-extension` запрещён) — injection/вставка
требуют ручного QA.

**Почему не OAuth в MVP:** `gmail.readonly`/`gmail.compose` — restricted scopes: публикация в CWS требует
OAuth verification и **security assessment (CASA)** — недели и деньги, плюс токены нельзя безопасно
хранить в чистом клиенте без сервера. Microsoft Graph требует publisher verification и admin consent.
DOM даёт 80% ценности за 1% усилий; OAuth — отдельный этап после валидации спроса.

**Дальше:**
1. Gmail API: `gmail.readonly` для чтения, `gmail.compose`/`gmail.send` для черновиков (отправка — всё
   равно только после явного подтверждения), OAuth через `chrome.identity.launchWebAuthFlow`, серверный
   обмен refresh-токена (без сервера нельзя — потребуется минимальный backend или Chrome Identity).
2. Microsoft Graph: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` (делегированные), MSAL, publisher
   verification; для enterprise — согласие администратора.
3. Гибрид: DOM остаётся fallback для корпоративных веб-почт и нестандартных доменов.
4. Restricted scopes означают security assessment для Gmail — планировать в бэклоге беты, не MVP.

## 8. Сборка, версионирование, артефакты

`extension/package.ps1` (PowerShell 5.1+, без npm):

1. читает `version` из `manifest.json`;
2. проверяет, что каждый файл, на который ссылается манифест, существует (service worker, side panel,
   options, иконки, content scripts);
3. копирует runtime-файлы в чистый staging (без `tools`, `dist`, `package.ps1`, README);
4. пишет zip с forward-slash entry names (не `Compress-Archive`, который на Windows ставит `\`) →
   `extension/dist/pocherk-<version>.zip`, manifest в корне архива;
5. печатает размер, число и список записей.

Версионирование: SemVer в `manifest.json`; `0.1.x` — первый скелет, `0.2.12` — открытое письмо и две кнопки анализа
по умолчанию, `0.3.0` — бета с OAuth-гибридом, `1.0.0` — публичный релиз. Каждый релиз — отдельный zip,
старые не перезаписываем; changelog в
`proposals/engineering/`.

## 9. Чек-лист публикации

**Chrome Web Store**

- [ ] Single purpose: «AI-ассистент, который читает активную страницу/письмо и предлагает текст ответа».
- [ ] Data use disclosure: категории данных (содержимое страниц/писем, настройки, история) и что уходит
      провайдеру; в политике — BYOK, отсутствие бэкенда, отсутствие продажи данных.
- [ ] Privacy policy — публичный URL (обязателен при работе с пользовательским контентом и ключами).
- [ ] Permission justification для каждого пункта (`storage`, `activeTab`, `scripting`, `sidePanel`,
      `contextMenus`, опциональные хосты, 20 доменов почты) — таблица из раздела 3 почти готова.
      MV3, без remote code, CSP не ослаблена, `minimum_chrome_version` указан.
- [ ] Скриншоты 1280×800 (до 5), иконка 128×128, промо; на скриншотах видно демо-режим и
      предупреждение «не отправляет письма само». Видео-демо — опционально.
- [ ] Аккаунт разработчика $5; ревью 1–4 недели, при OAuth-скоупах — CASA security assessment.
- [ ] Нет тестовых ключей/секретов в архиве и репозитории.

**Microsoft Edge Add-ons**

- [ ] Отдельная карточка в Partner Center (можно переиспользовать zip и тексты); Edge **также принимает
      установку из Chrome Web Store**, но для листинга в Edge Add-ons карточка нужна. После установки
      проверить side panel в Edge (список в разделе 2).
- [ ] Политики Edge: single purpose, достоверное описание, отсутствие накрутки, privacy policy.
- [ ] Скриншоты/иконки по требованиям Edge; ревью обычно 1–7 рабочих дней. Предусмотреть понятную ошибку,
      если enterprise-политика блокирует опциональные хосты.

**Общее:** store listing на английском (или локализован), лицензия, поддержка/контакты, версия и changelog.

## 10. «Читает ли Почерк страницы самого Chrome?»

Да — но только обычные веб-страницы и только по доступу, который даёт пользователь.

- **Как:** `content.js` внедряется декларативно на 20 доменов почты и по требованию на остальные страницы
  через `activeTab` + `chrome.scripting.executeScript` (кнопка «Объяснить страницу», быстрое действие,
  контекстное меню, `Ctrl+Shift+Y` + запрос). Скрипт читает DOM: выбирает основной контейнер
  Readability-подобной эвристикой (оценка абзацев, плотность ссылок), собирает заголовки, описание,
  язык; текст нормализуется и обрезается до 14 000 символов.
- **Лимит и «чанкинг»:** в MVP — только обрезка, без карты/суммаризации по частям. Для длинных
  страниц честнее показать «текст извлечён частично» (флаг `truncated`), чем молча терять контекст.
  В бете: чанкинг + локальная выжимка или двухпроходный запрос к дешёвой модели.
- **Чего не прочитает:** `chrome://`, `edge://`, `about:`, `chrome-extension://`, `devtools://`
  (браузер запрещает инжект), Chrome Web Store / Edge Add-ons (запрещено политикой), PDF-вьювер
  (встроенный, без текстового слоя в DOM), содержимое `<iframe>` (контент-скрипт в top-frame),
  canvas/WebGL-текст, изображения без alt, closed Shadow DOM, текст, подгружаемый ленивой прокруткой
  (скрипт не скроллит сам), поля паролей и страницы под enterprise-политикой с запретом инжекта.

## 11. Ограничения скелета и что доделать до беты

| Область | Сейчас | До беты |
| --- | --- | --- |
| Почта | DOM-селекторы, best-effort | Gmail API + Graph (OAuth), DOM как fallback; тесты на 3 версии вёрстки |
| Страницы | обрезка 14k, один проход | чанкинг, выжимка, кэш извлечения по URL |
| Стиль | эвристические правила, 30 пар | нормальный diff, точечные правила по типам писем, экспорт/импорт профиля |
| Голос | Web Speech API | опция Whisper/local STT, выбор устройства ввода |
| Настройки | один профиль | несколько профилей/команд, sync (осознанно), ключи через менеджер паролей |
| Тесты | ручная проверка + синтаксис | unit-тесты парсеров/промптов, e2e на Playwright с расширением |
| UI | панель + options | a11y-аудит (focus-trap, скринридер), локализация en |
| Безопасность | nonce-обёртка, нет автоотправки | аудит prompt injection, лимиты стоимости, red-team письма |

Открытые вопросы: OAuth-токены для Gmail/Graph; хранение писем; память «двойника» между сессиями; метрика качества стиля.
