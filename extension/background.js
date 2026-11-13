/**
 * background.js — service worker (MV3) для Chrome и Edge.
 *
 * Задачи:
 *  - открывать side panel (иконка, горячая клавиша Ctrl+Shift+Y, контекстное меню);
 *  - контекстное меню «Спросить AI про выделенное»;
 *  - по требованию инжектировать content.js в активную вкладку (activeTab + scripting);
 *  - маршрутизировать сообщения между side panel и content script;
 *  - хранить «отложенный контекст» (выделение/письмо), пока панель загружается.
 *
 * Здесь НЕТ сетевых вызовов: за LLM отвечает side panel через lib/llm-client.js.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS, LIMITS, isWebmailHost } from './lib/config.js';

const MENU_OPEN = 'open-ai-bro';
const CONTENT_TARGET = 'content';

let memoryPending = null;
let cachedActiveTab = null;

function rememberActiveTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  // В кэш — только настоящие http(s)-вкладки: chrome-extension:// и chrome://
  // не должны становиться «активной вкладкой» панели.
  if (!/^https?:/i.test(tab.url || '')) return;
  cachedActiveTab = {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
  };
}

function toTabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    isMail: isWebmailUrl(tab.url || ''),
    restricted: /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(tab.url || ''),
  };
}

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

function isWebmailUrl(url) {
  try {
    const parsed = new URL(url);
    return isWebmailHost(parsed.hostname);
  } catch {
    return false;
  }
}

function safeRuntimeSend(message) {
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* нет слушателя — панель закрыта */
  }
}

async function setPending(context) {
  memoryPending = context;
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.pending]: context });
  } catch {
    /* storage.session недоступен — останется в памяти SW */
  }
}

async function readPending() {
  let context = memoryPending;
  try {
    const data = await chrome.storage.session.get(STORAGE_KEYS.pending);
    if (data && data[STORAGE_KEYS.pending]) context = data[STORAGE_KEYS.pending];
  } catch {
    /* ignore */
  }
  return context || null;
}

async function clearPending() {
  memoryPending = null;
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.pending);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* side panel                                                          */
/* ------------------------------------------------------------------ */

async function setupSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return true;
  } catch (error) {
    console.warn('[AI Bro] setPanelBehavior недоступен:', error && error.message);
    return false;
  }
}

async function openPanelWindow(tab) {
  // Chrome 114–115: sidePanel.open() ещё нет — открываем панель отдельным окном.
  // Передаём tabId, иначе popup увидит собственную extension-вкладку как active.
  try {
    const target = tab && Number.isInteger(tab.id) ? tab : cachedActiveTab;
    const base = chrome.runtime.getURL('sidepanel.html');
    const url = target && Number.isInteger(target.id) ? `${base}?tabId=${target.id}` : base;
    await chrome.windows.create({ url, type: 'popup', width: 430, height: 800 });
    return true;
  } catch (error) {
    console.warn('[AI Bro] fallback window:', error && error.message);
    return false;
  }
}

/**
 * Открывает панель. ВАЖНО: chrome.sidePanel.open() вызывается синхронно,
 * до первого await — иначе браузер теряет user gesture.
 */
function openPanelForTab(tab) {
  const target = tab && Number.isInteger(tab.id) ? tab : cachedActiveTab;
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    const options = [];
    if (target && Number.isInteger(target.id)) options.push({ tabId: target.id });
    if (target && Number.isInteger(target.windowId)) options.push({ windowId: target.windowId });
    for (const option of options) {
      try {
        const promise = chrome.sidePanel.open(option);
        if (promise && typeof promise.catch === 'function') {
          promise.catch((error) => {
            console.warn('[AI Bro] sidePanel.open не удался, fallback:', error && error.message);
            openPanelWindow(target);
          });
        }
        return true;
      } catch (error) {
        console.warn('[AI Bro] sidePanel.open исключение:', error && error.message);
      }
    }
  }
  openPanelWindow(target);
  return false;
}

/* ------------------------------------------------------------------ */
/* context menu                                                        */
/* ------------------------------------------------------------------ */

let menuSync = Promise.resolve();

function createContextMenus() {
  // Идемпотентно: вызовы с onInstalled/onStartup/старта service worker
  // сериализуются, поэтому дубликаты id и Unchecked runtime.lastError не появляются.
  menuSync = menuSync
    .then(
      () =>
        new Promise((resolve) => {
          try {
            chrome.contextMenus.removeAll(() => {
              void chrome.runtime.lastError;
              const items = [{ id: MENU_OPEN, title: 'Открыть AI Bro', contexts: ['page', 'selection'] }];
              for (const item of items) {
                try {
                  chrome.contextMenus.create(item, () => {
                    void chrome.runtime.lastError;
                  });
                } catch {
                  /* ignore */
                }
              }
              resolve();
            });
          } catch {
            resolve();
          }
        }),
    )
    .catch(() => {});
}

async function readSelectionFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(window.getSelection ? window.getSelection().toString() : '').slice(0, 4000),
    });
    return (results && results[0] && results[0].result) || '';
  } catch {
    return '';
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !Number.isInteger(tab.id)) return;
  // Единственный пункт меню — открыть панель. Контент не читаем.
  openPanelForTab(tab);
});

/* ------------------------------------------------------------------ */
/* action / commands                                                   */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  // Сработает только если setPanelBehavior не включился (старый браузер/Edge).
  openPanelForTab(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-panel') return;
  // Кэш активной вкладки обновляется listeners ниже; открываем без await.
  if (cachedActiveTab) {
    openPanelForTab(cachedActiveTab);
    return;
  }
  chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs && tabs[0];
      if (tab) openPanelForTab(tab);
      else chrome.runtime.openOptionsPage();
    })
    .catch(() => {});
});

/* ------------------------------------------------------------------ */
/* content script injection (activeTab + scripting)                    */
/* ------------------------------------------------------------------ */

function classifyInjectionError(error) {
  const message = String((error && error.message) || error || '');
  if (/chrome:\/\//.test(message) || /chrome-extension:\/\//.test(message)) return 'RESTRICTED_URL';
  if (/extensions gallery|cannot be scripted/i.test(message)) return 'WEBSTORE';
  if (/Cannot access contents|Missing host permission|The extensions gallery/i.test(message)) return 'NO_HOST_ACCESS';
  if (/No tab with id|Invalid tab ID/i.test(message)) return 'NO_TAB';
  return 'INJECT_FAILED';
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { target: CONTENT_TARGET, type: 'PING' });
    if (ping && ping.ok) return { ok: true, injected: false, isMail: !!ping.isMail, site: ping.site || null };
  } catch {
    /* ещё не внедрён */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    return { ok: false, injected: false, reason: classifyInjectionError(error), message: String((error && error.message) || error) };
  }
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { target: CONTENT_TARGET, type: 'PING' });
    if (ping && ping.ok) return { ok: true, injected: true, isMail: !!ping.isMail, site: ping.site || null };
    return { ok: false, injected: true, reason: 'NO_RESPONSE' };
  } catch {
    return { ok: false, injected: true, reason: 'NO_RESPONSE' };
  }
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  const type = message.type;

  // --- от content script: пользователь нажал плавающую кнопку на почте
  if (type === 'AI_COPILOT_FROM_PAGE') {
    const tab = sender && sender.tab;
    // Сначала жест: sidePanel.open синхронно, затем сохранение контекста.
    if (tab) openPanelForTab(tab);
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    const context = {
      kind: payload.kind || 'page',
      site: payload.site || null,
      text: String(payload.text || '').slice(0, LIMITS.selectionChars),
      mail: payload.mail || null,
      page: payload.page || null,
      url: (tab && tab.url) || '',
      title: (tab && tab.title) || '',
      ts: Date.now(),
    };
    (async () => {
      await setPending(context);
      safeRuntimeSend({ type: 'CONTEXT_PUSH', context });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (type === 'ENSURE_CONTENT') {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, reason: 'NO_TAB' });
      return undefined;
    }
    ensureContentScript(tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: 'INJECT_FAILED', message: String((error && error.message) || error) });
    });
    return true;
  }

  if (type === 'GET_ACTIVE_TAB') {
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false, reason: 'NO_TAB' });
          return;
        }
        // Popup-fallback: активная вкладка — собственная extension-страница.
        // Не отдаём её как контекст; панель должна использовать tabId из URL.
        if (/^chrome-extension:/i.test(tab.url || '')) {
          sendResponse({ ok: false, reason: 'NO_TAB' });
          return;
        }
        rememberActiveTab(tab);
        sendResponse({ ok: true, tab: toTabInfo(tab) });
      })
      .catch((error) => sendResponse({ ok: false, reason: 'NO_TAB', message: String((error && error.message) || error) }));
    return true;
  }

  if (type === 'GET_TAB') {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, reason: 'NO_TAB' });
      return undefined;
    }
    chrome.tabs
      .get(tabId)
      .then((tab) => sendResponse({ ok: true, tab: toTabInfo(tab) }))
      .catch(() => sendResponse({ ok: false, reason: 'NO_TAB' }));
    return true;
  }

  if (type === 'GET_PENDING_CONTEXT') {
    readPending()
      .then(async (context) => {
        if (message.clear !== false) await clearPending();
        sendResponse({ ok: true, context: context || null });
      })
      .catch(() => sendResponse({ ok: true, context: null }));
    return true;
  }

  if (type === 'CLEAR_PENDING_CONTEXT') {
    clearPending().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'SET_PENDING_CONTEXT') {
    const context = message.context && typeof message.context === 'object' ? message.context : null;
    (context ? setPending(context) : clearPending()).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  }

  if (type === 'OPEN_PANEL') {
    if (cachedActiveTab) {
      const opened = openPanelForTab(cachedActiveTab);
      sendResponse({ ok: opened });
      return undefined;
    }
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false });
          return;
        }
        openPanelForTab(tab);
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (type === 'PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return undefined;
  }

  return undefined;
});

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function seedDefaults() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    if (!stored[STORAGE_KEYS.settings]) {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
    }
  } catch (error) {
    console.warn('[AI Bro] seedDefaults:', error && error.message);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  createContextMenus();
  setupSidePanelBehavior();
  seedDefaults();
  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  setupSidePanelBehavior();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs
    .get(tabId)
    .then(rememberActiveTab)
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Только активная вкладка: фоновая догрузка не должна подменять контекст команды.
  if (!tab || tab.active !== true) return;
  if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) rememberActiveTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cachedActiveTab && cachedActiveTab.id === tabId) cachedActiveTab = null;
});

chrome.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then((tabs) => {
    if (tabs && tabs[0]) rememberActiveTab(tabs[0]);
  })
  .catch(() => {});

// Стартовое поведение (SW мог проснуться без onInstalled/onStartup).
setupSidePanelBehavior();
