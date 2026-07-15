"use strict";

const DB_NAME = "tab-restore-db";
const DB_VERSION = 1;
const STATE_STORE = "states";
const TAB_STATE_KEY = "tabRestore.stateId";
const TAB_FORCE_KEY = "tabRestore.forceUntil";
const RECENT_CLOSED_KEY = "tabRestore.recentClosed";
const MAX_STATES = 200;

const DEFAULT_SETTINGS = Object.freeze({
  autoRestore: true,
  categories: {
    editorCode: true,
    formInputs: true,
    contentEditable: true,
    scroll: true,
    focusSelection: true,
    media: true,
    uiState: true,
    historyState: true,
    iframes: true,
    siteStorage: true,
    pageVariables: true
  },
  shortcuts: {
    enabled: false,
    restore: true,
    reload: true
  }
});

let databasePromise;
let writeQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(saved = {}) {
  return {
    ...clone(DEFAULT_SETTINGS),
    ...saved,
    categories: {
      ...DEFAULT_SETTINGS.categories,
      ...(saved.categories || {})
    },
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...(saved.shortcuts || {})
    }
  };
}

async function getSettings() {
  const result = await chrome.storage.local.get("settings");
  return mergeSettings(result.settings);
}

async function saveSettings(next) {
  const settings = mergeSettings(next);
  await chrome.storage.local.set({ settings });
  return settings;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        const store = db.createObjectStore(STATE_STORE, { keyPath: "id" });
        store.createIndex("urlKey", "urlKey", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function withStore(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, mode);
    const store = transaction.objectStore(STATE_STORE);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getState(id) {
  if (!id) return null;
  const db = await openDatabase();
  const transaction = db.transaction(STATE_STORE, "readonly");
  return requestResult(transaction.objectStore(STATE_STORE).get(id));
}

async function putState(state) {
  await withStore("readwrite", (store) => store.put(state));
  return state;
}

async function getAllStates() {
  const db = await openDatabase();
  const transaction = db.transaction(STATE_STORE, "readonly");
  return requestResult(transaction.objectStore(STATE_STORE).getAll());
}

async function findLatestByUrl(url) {
  const key = urlKey(url);
  if (!key) return null;
  const db = await openDatabase();
  const transaction = db.transaction(STATE_STORE, "readonly");
  const matches = await requestResult(
    transaction.objectStore(STATE_STORE).index("urlKey").getAll(key)
  );
  return matches.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

async function findLatestState() {
  const states = await getAllStates();
  return states
    .filter((state) => isRestorableUrl(state.url))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

async function countStates() {
  const db = await openDatabase();
  const transaction = db.transaction(STATE_STORE, "readonly");
  return requestResult(transaction.objectStore(STATE_STORE).count());
}

async function pruneStates() {
  const states = (await getAllStates()).sort((a, b) => b.updatedAt - a.updatedAt);
  if (states.length <= MAX_STATES) return;
  const removeIds = states.slice(MAX_STATES).map((state) => state.id);
  await withStore("readwrite", (store) => {
    for (const id of removeIds) store.delete(id);
  });
}

function enqueueWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => undefined);
  return next;
}

function urlKey(url) {
  try {
    const parsed = new URL(url);
    if (!isRestorableUrl(parsed.href)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function isRestorableUrl(url = "") {
  return /^(https?:|file:)/i.test(url);
}

function makeState(url, source = null) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    url,
    urlKey: urlKey(url),
    title: source?.title || "",
    createdAt: now,
    updatedAt: now,
    frames: source?.frames ? clone(source.frames) : {}
  };
}

async function getTabValue(tabId, key) {
  const storageKey = `${key}:${tabId}`;
  try {
    const result = await chrome.storage.session.get(storageKey);
    return result[storageKey] ?? null;
  } catch {
    return null;
  }
}

async function setTabValue(tabId, key, value) {
  const storageKey = `${key}:${tabId}`;
  try {
    await chrome.storage.session.set({ [storageKey]: value });
  } catch {
    // Session storage can be unavailable while the extension is shutting down.
  }
}

async function removeTabValues(tabId) {
  try {
    await chrome.storage.session.remove([
      `${TAB_STATE_KEY}:${tabId}`,
      `${TAB_FORCE_KEY}:${tabId}`
    ]);
  } catch {}
}

async function claimRecentlyClosed(url) {
  const key = urlKey(url);
  if (!key) return null;
  try {
    const result = await chrome.storage.session.get(RECENT_CLOSED_KEY);
    const recent = Array.isArray(result[RECENT_CLOSED_KEY]) ? result[RECENT_CLOSED_KEY] : [];
    const now = Date.now();
    const index = recent.findIndex((item) => item.urlKey === key && now - item.closedAt < 30 * 60 * 1000);
    if (index < 0) return null;
    const [match] = recent.splice(index, 1);
    await chrome.storage.session.set({
      [RECENT_CLOSED_KEY]: recent.filter((item) => now - item.closedAt < 30 * 60 * 1000).slice(0, 50)
    });
    return getState(match.stateId);
  } catch {
    return null;
  }
}

async function rememberClosedTab(tabId) {
  const stateId = await getTabValue(tabId, TAB_STATE_KEY);
  const state = await getState(stateId);
  if (state) {
    try {
      const result = await chrome.storage.session.get(RECENT_CLOSED_KEY);
      const recent = Array.isArray(result[RECENT_CLOSED_KEY]) ? result[RECENT_CLOSED_KEY] : [];
      recent.unshift({
        stateId: state.id,
        url: state.url,
        urlKey: state.urlKey,
        closedAt: Date.now()
      });
      await chrome.storage.session.set({ [RECENT_CLOSED_KEY]: recent.slice(0, 50) });
    } catch {}
  }
  await removeTabValues(tabId);
}

async function stateForRestore(tab, requestedUrl) {
  const currentUrl = isRestorableUrl(requestedUrl) ? requestedUrl : tab.url;
  const currentKey = urlKey(currentUrl);
  const assignedId = await getTabValue(tab.id, TAB_STATE_KEY);
  const assigned = await getState(assignedId);

  if (assigned && assigned.urlKey === currentKey) return assigned;

  const source = (await claimRecentlyClosed(currentUrl)) || (await findLatestByUrl(currentUrl));
  if (!source) return null;

  const copied = makeState(currentUrl, source);
  await putState(copied);
  await setTabValue(tab.id, TAB_STATE_KEY, copied.id);
  return copied;
}

async function stateForSave(tab) {
  const currentUrl = tab.url;
  const currentKey = urlKey(currentUrl);
  const assignedId = await getTabValue(tab.id, TAB_STATE_KEY);
  const assigned = await getState(assignedId);
  if (assigned && assigned.urlKey === currentKey) return assigned;

  const state = makeState(currentUrl);
  await putState(state);
  await setTabValue(tab.id, TAB_STATE_KEY, state.id);
  return state;
}

function chooseFrame(state, frameId, frameUrl, framePath) {
  const frames = Object.values(state?.frames || {});
  if (!frames.length) return null;
  if (frameId === 0) return state.frames["frame:0"] || frames.find((frame) => frame.isTop) || null;

  if (framePath) {
    const pathMatch = frames.find((frame) => frame.framePath === framePath);
    if (pathMatch) return pathMatch;
  }

  const sameId = state.frames[`frame:${frameId}`];
  if (sameId && urlKey(sameId.url) === urlKey(frameUrl)) return sameId;

  return frames
    .filter((frame) => !frame.isTop && urlKey(frame.url) === urlKey(frameUrl))
    .sort((a, b) => (a.savedFrameId || 0) - (b.savedFrameId || 0))[0] || null;
}

function mergeFrame(previous, incoming) {
  if (!previous) return incoming;
  if (incoming.fast) {
    return {
      ...previous,
      ...incoming,
      page: incoming.page || previous.page
    };
  }
  return incoming;
}

async function saveSnapshot(message, sender) {
  if (!sender.tab?.id || !isRestorableUrl(sender.tab.url)) return { saved: false };
  return enqueueWrite(async () => {
    const state = await stateForSave(sender.tab);
    const frameKey = `frame:${sender.frameId || 0}`;
    const snapshot = {
      ...message.snapshot,
      savedFrameId: sender.frameId || 0,
      updatedAt: Date.now()
    };
    state.frames[frameKey] = mergeFrame(state.frames[frameKey], snapshot);
    if ((sender.frameId || 0) === 0) {
      state.url = sender.tab.url;
      state.urlKey = urlKey(sender.tab.url);
      state.title = message.snapshot.title || sender.tab.title || state.title;
    }
    state.updatedAt = Date.now();
    await putState(state);
    if (Math.random() < 0.03) await pruneStates();
    return { saved: true, stateId: state.id, updatedAt: state.updatedAt };
  });
}

async function restorePayload(message, sender) {
  if (!sender.tab?.id || !isRestorableUrl(sender.tab.url)) {
    return { shouldRestore: false, settings: await getSettings() };
  }

  const settings = await getSettings();
  const state = await enqueueWrite(() => stateForRestore(sender.tab, message.url));
  const forceUntil = Number(await getTabValue(sender.tab.id, TAB_FORCE_KEY)) || 0;
  const forced = Boolean(message.force) || forceUntil > Date.now();
  const shouldRestore = Boolean(state) && (settings.autoRestore || forced);
  const snapshot = state
    ? chooseFrame(state, sender.frameId || 0, message.url, message.framePath)
    : null;

  return {
    shouldRestore: shouldRestore && Boolean(snapshot),
    settings,
    snapshot,
    stateId: state?.id || null,
    stateUpdatedAt: state?.updatedAt || null
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function sendToTab(tabId, message, options) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    return null;
  }
}

async function ensureScripts(tab) {
  if (!tab?.id || !isRestorableUrl(tab.url)) return false;
  const pong = await sendToTab(tab.id, { type: "PING" }, { frameId: 0 });
  if (pong?.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["page-bridge.js"],
      world: "MAIN",
      injectImmediately: true
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
      world: "ISOLATED",
      injectImmediately: true
    });
    return true;
  } catch {
    return false;
  }
}

async function restoreActive({ onlyCategories = null, fromShortcut = false } = {}) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false };

  if (!isRestorableUrl(tab.url)) {
    if (!fromShortcut) return { ok: false, restricted: true };
    const latest = await findLatestState();
    if (!latest) return { ok: false, empty: true };
    await setTabValue(tab.id, TAB_STATE_KEY, latest.id);
    await setTabValue(tab.id, TAB_FORCE_KEY, Date.now() + 15000);
    await chrome.tabs.update(tab.id, { url: latest.url });
    return { ok: true, opened: latest.url };
  }

  if (fromShortcut) await setTabValue(tab.id, TAB_FORCE_KEY, Date.now() + 10000);
  if (!(await ensureScripts(tab))) return { ok: false, restricted: true };
  await sendToTab(tab.id, {
    type: "RESTORE_NOW",
    onlyCategories,
    force: true
  });
  return { ok: true };
}

async function saveActive() {
  const tab = await activeTab();
  if (!tab?.id || !isRestorableUrl(tab.url)) return { ok: false, restricted: true };
  if (!(await ensureScripts(tab))) return { ok: false, restricted: true };
  await sendToTab(tab.id, { type: "CAPTURE_NOW" });
  return { ok: true };
}

async function reloadAndRestore() {
  const tab = await activeTab();
  if (!tab?.id || !isRestorableUrl(tab.url)) return { ok: false, restricted: true };
  await ensureScripts(tab);
  await sendToTab(tab.id, { type: "CAPTURE_NOW", immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await setTabValue(tab.id, TAB_FORCE_KEY, Date.now() + 15000);
  await chrome.tabs.reload(tab.id);
  return { ok: true };
}

async function updateSettings(message) {
  const current = await getSettings();
  const patch = message.patch || {};
  const next = mergeSettings({
    ...current,
    ...patch,
    categories: { ...current.categories, ...(patch.categories || {}) },
    shortcuts: { ...current.shortcuts, ...(patch.shortcuts || {}) }
  });
  await saveSettings(next);

  if (message.restoreNow) {
    await restoreActive({ onlyCategories: message.onlyCategories || null });
  }
  return { ok: true, settings: next };
}

async function popupData() {
  const [settings, latest, total, tab] = await Promise.all([
    getSettings(),
    findLatestState(),
    countStates(),
    activeTab()
  ]);
  let tabState = null;
  if (tab?.id && isRestorableUrl(tab.url)) {
    const assignedId = await getTabValue(tab.id, TAB_STATE_KEY);
    tabState = (await getState(assignedId)) || (await findLatestByUrl(tab.url));
  }
  return {
    settings,
    total,
    latest: latest ? { url: latest.url, title: latest.title, updatedAt: latest.updatedAt } : null,
    current: tabState ? { url: tabState.url, title: tabState.title, updatedAt: tabState.updatedAt } : null,
    restorable: Boolean(tab && isRestorableUrl(tab.url))
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    SAVE_SNAPSHOT: () => saveSnapshot(message, sender),
    RESTORE_REQUEST: () => restorePayload(message, sender),
    GET_SETTINGS: () => getSettings(),
    UPDATE_SETTINGS: () => updateSettings(message),
    GET_POPUP_DATA: () => popupData(),
    SAVE_ACTIVE: () => saveActive(),
    RESTORE_ACTIVE: () => restoreActive({ onlyCategories: message.onlyCategories || null }),
    RELOAD_AND_RESTORE: () => reloadAndRestore(),
    OPEN_SHORTCUTS: async () => {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      return { ok: true };
    }
  };

  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();
  if (!settings.shortcuts.enabled) return;
  if (command === "restore-current" && settings.shortcuts.restore) {
    await restoreActive({ fromShortcut: true });
  }
  if (command === "reload-and-restore" && settings.shortcuts.reload) {
    await reloadAndRestore();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueWrite(() => rememberClosedTab(tabId));
});
