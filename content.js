"use strict";

(() => {
  if (globalThis.__TAB_RESTORE_CONTENT__) return;
  globalThis.__TAB_RESTORE_CONTENT__ = true;

  const FROM_CONTENT = "TAB_RESTORE_CONTENT";
  const FROM_PAGE = "TAB_RESTORE_PAGE";
  const MAX_CONTROLS = 1500;
  const MAX_EDITABLES = 350;
  const MAX_SCROLL_ELEMENTS = 500;
  const MAX_MEDIA = 100;
  const MAX_HTML_CHARS = 1_000_000;
  const isTop = window === window.top;

  let settings = null;
  let captureEnabled = false;
  let captureTimer = null;
  let captureInProgress = false;
  let captureQueued = false;
  let lastPageState = null;
  let lastPageStateAt = 0;
  let restoringUntil = 0;
  let activeRoots = null;
  const scrolledElements = new Set();
  const bridgeRequests = new Map();

  function runtimeMessage(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
  }

  function collectRoots() {
    const roots = [document];
    const seen = new Set(roots);
    for (let index = 0; index < roots.length && roots.length < 300; index += 1) {
      let elements = [];
      try { elements = roots[index].querySelectorAll("*"); } catch { continue; }
      for (const element of elements) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          roots.push(element.shadowRoot);
        }
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    const results = [];
    for (const root of activeRoots || collectRoots()) {
      try { results.push(...root.querySelectorAll(selector)); } catch {}
    }
    return results;
  }

  function uniqueInRoot(root, selector) {
    try { return root.querySelectorAll(selector).length === 1; } catch { return false; }
  }

  function selectorWithinRoot(element, root) {
    if (!(element instanceof Element)) return "";
    if (element.id) {
      const selector = `#${cssEscape(element.id)}`;
      if (uniqueInRoot(root, selector)) return selector;
    }

    for (const attribute of ["data-testid", "data-test", "data-id"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `[${attribute}="${cssEscape(value)}"]`;
      if (uniqueInRoot(root, selector)) return selector;
    }

    if (element.getAttribute("name")) {
      const selector = `${element.localName}[name="${cssEscape(element.getAttribute("name"))}"]`;
      if (uniqueInRoot(root, selector)) return selector;
    }

    const parts = [];
    let current = element;
    while (current && current !== root && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.localName;
      if (!part) break;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
      if (parts.length >= 10) break;
    }
    return parts.join(" > ");
  }

  function makePath(element) {
    if (!(element instanceof Element)) return null;
    const parts = [];
    let current = element;
    for (let depth = 0; depth < 12 && current; depth += 1) {
      const root = current.getRootNode();
      const selector = selectorWithinRoot(current, root);
      if (!selector) return null;
      parts.unshift(selector);
      if (!(root instanceof ShadowRoot)) break;
      current = root.host;
    }
    return parts.length ? parts : null;
  }

  function resolvePath(parts) {
    if (!Array.isArray(parts) || !parts.length) return null;
    let root = document;
    let element = null;
    for (let index = 0; index < parts.length; index += 1) {
      try { element = root.querySelector(parts[index]); } catch { return null; }
      if (!element) return null;
      if (index < parts.length - 1) {
        root = element.shadowRoot;
        if (!root) return null;
      }
    }
    return element;
  }

  function framePath() {
    if (isTop) return "top";
    const parts = [];
    let current = window;
    try {
      for (let depth = 0; depth < 10 && current !== current.top; depth += 1) {
        const frame = current.frameElement;
        if (!frame) return null;
        const frames = Array.from(current.parent.document.querySelectorAll("iframe, frame"));
        parts.unshift(frames.indexOf(frame));
        current = current.parent;
      }
      return parts.every((part) => part >= 0) ? parts.join(".") : null;
    } catch {
      return null;
    }
  }

  function postToPage(type, payload, timeout = 350) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridgeRequests.delete(requestId);
        resolve(null);
      }, timeout);
      bridgeRequests.set(requestId, { resolve, timer });
      window.postMessage({ source: FROM_CONTENT, requestId, type, payload }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== FROM_PAGE) return;
    const pending = bridgeRequests.get(event.data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    bridgeRequests.delete(event.data.requestId);
    pending.resolve(event.data.payload);
  });

  function excludedInput(element) {
    if (!(element instanceof HTMLInputElement)) return false;
    const type = (element.type || "text").toLowerCase();
    if (["password", "file", "hidden"].includes(type)) return true;
    const autocomplete = (element.autocomplete || "").toLowerCase();
    return ["current-password", "new-password", "one-time-code", "cc-csc"].includes(autocomplete);
  }

  function collectControls() {
    const controls = [];
    for (const element of deepQueryAll("input, textarea, select")) {
      if (controls.length >= MAX_CONTROLS) break;
      if (excludedInput(element)) continue;
      const path = makePath(element);
      if (!path) continue;
      const item = { path, tag: element.localName };
      if (element instanceof HTMLInputElement) {
        item.type = element.type;
        item.value = element.value;
        item.checked = element.checked;
        if (["text", "search", "url", "tel", "email", "number"].includes(element.type)) {
          item.selectionStart = element.selectionStart;
          item.selectionEnd = element.selectionEnd;
          item.selectionDirection = element.selectionDirection;
        }
      } else if (element instanceof HTMLTextAreaElement) {
        item.value = element.value;
        item.selectionStart = element.selectionStart;
        item.selectionEnd = element.selectionEnd;
        item.selectionDirection = element.selectionDirection;
      } else if (element instanceof HTMLSelectElement) {
        item.value = element.value;
        item.selected = Array.from(element.options).map((option) => option.selected);
      }
      controls.push(item);
    }
    return controls;
  }

  function collectEditables() {
    const editables = [];
    let total = 0;
    for (const element of deepQueryAll("[contenteditable]:not([contenteditable='false'])")) {
      if (editables.length >= MAX_EDITABLES || total >= MAX_HTML_CHARS) break;
      if (element.parentElement?.closest?.("[contenteditable]:not([contenteditable='false'])")) continue;
      const path = makePath(element);
      if (!path) continue;
      const html = element.innerHTML.slice(0, Math.min(300_000, MAX_HTML_CHARS - total));
      total += html.length;
      editables.push({ path, html });
    }
    return editables;
  }

  function collectScroll() {
    const candidates = new Set(scrolledElements);
    let scanned = 0;
    for (const root of activeRoots || collectRoots()) {
      let elements = [];
      try { elements = root.querySelectorAll("*"); } catch { continue; }
      for (const element of elements) {
        if (scanned++ >= 6000 || candidates.size >= MAX_SCROLL_ELEMENTS) break;
        if (element.scrollTop || element.scrollLeft) candidates.add(element);
      }
      if (scanned >= 6000 || candidates.size >= MAX_SCROLL_ELEMENTS) break;
    }
    const elements = [];
    for (const element of candidates) {
      if (!(element instanceof Element) || !element.isConnected) continue;
      const path = makePath(element);
      if (!path) continue;
      elements.push({ path, top: element.scrollTop, left: element.scrollLeft });
      if (elements.length >= MAX_SCROLL_ELEMENTS) break;
    }
    return { windowX: window.scrollX, windowY: window.scrollY, elements };
  }

  function nodePoint(node, offset) {
    if (!node) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return null;
    const path = makePath(element);
    if (!path) return null;
    const childPath = [];
    let current = node;
    while (current && current !== element) {
      const parent = current.parentNode;
      if (!parent) break;
      childPath.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return { path, childPath, offset };
  }

  function resolveNodePoint(point) {
    if (!point) return null;
    let node = resolvePath(point.path);
    if (!node) return null;
    for (const index of point.childPath || []) {
      node = node.childNodes[index];
      if (!node) return null;
    }
    const maxOffset = node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
    return { node, offset: Math.min(Math.max(0, point.offset || 0), maxOffset) };
  }

  function collectFocusSelection() {
    const active = document.activeElement;
    const selection = window.getSelection?.();
    return {
      focus: active && active !== document.body ? makePath(active) : null,
      selection: selection?.rangeCount ? {
        anchor: nodePoint(selection.anchorNode, selection.anchorOffset),
        focus: nodePoint(selection.focusNode, selection.focusOffset),
        backward: false
      } : null
    };
  }

  function collectMedia() {
    return deepQueryAll("video, audio").slice(0, MAX_MEDIA).map((element) => ({
      path: makePath(element),
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      volume: element.volume,
      muted: element.muted,
      paused: element.paused,
      playbackRate: element.playbackRate
    })).filter((item) => item.path);
  }

  function collectUiState() {
    return {
      details: deepQueryAll("details").slice(0, 300).map((element) => ({ path: makePath(element), open: element.open })).filter((item) => item.path),
      dialogs: deepQueryAll("dialog").slice(0, 100).map((element) => ({ path: makePath(element), open: element.open })).filter((item) => item.path)
    };
  }

  function collectHistoryState() {
    let state = null;
    try { state = structuredClone(history.state); } catch {
      try { state = JSON.parse(JSON.stringify(history.state)); } catch {}
    }
    return { url: location.href, state };
  }

  function collectDomState() {
    activeRoots = collectRoots();
    try {
      return {
        controls: collectControls(),
        editables: collectEditables(),
        scroll: collectScroll(),
        focusSelection: collectFocusSelection(),
        media: collectMedia(),
        ui: collectUiState(),
        history: collectHistoryState()
      };
    } finally {
      activeRoots = null;
    }
  }

  async function captureNow(fast = false) {
    if (!captureEnabled || captureInProgress) {
      captureQueued = true;
      return;
    }
    captureInProgress = true;
    captureQueued = false;
    try {
      const dom = collectDomState();
      if (!fast && Date.now() - lastPageStateAt > 1800) {
        const page = await postToPage("CAPTURE_PAGE_STATE", null, 500);
        if (page) {
          lastPageState = page;
          lastPageStateAt = Date.now();
        }
      }
      await runtimeMessage({
        type: "SAVE_SNAPSHOT",
        snapshot: {
          url: location.href,
          title: document.title,
          isTop,
          framePath: framePath(),
          capturedAt: Date.now(),
          fast,
          dom,
          page: lastPageState
        }
      });
    } finally {
      captureInProgress = false;
      if (captureQueued) scheduleCapture(150);
    }
  }

  function scheduleCapture(delay = 700) {
    if (!captureEnabled || Date.now() < restoringUntil) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => captureNow(false), delay);
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    try {
      if (setter) setter.call(element, value);
      else element.value = value;
    } catch {
      element.value = value;
    }
  }

  function emitInput(element) {
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: null }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function restoreControls(controls) {
    for (const saved of controls || []) {
      const element = resolvePath(saved.path);
      if (!element || excludedInput(element)) continue;
      try {
        let changed = false;
        if (element instanceof HTMLSelectElement) {
          (saved.selected || []).forEach((selected, index) => {
            if (element.options[index] && element.options[index].selected !== selected) {
              element.options[index].selected = selected;
              changed = true;
            }
          });
          if (!saved.selected && element.value !== saved.value) {
            element.value = saved.value;
            changed = true;
          }
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          if (element.value !== saved.value) {
            setNativeValue(element, saved.value ?? "");
            changed = true;
          }
          if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
            if (element.checked !== Boolean(saved.checked)) {
              element.checked = Boolean(saved.checked);
              changed = true;
            }
          }
          if (Number.isInteger(saved.selectionStart) && element.setSelectionRange) {
            element.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection || "none");
          }
        }
        if (changed) emitInput(element);
      } catch {}
    }
  }

  function restoreEditables(editables) {
    for (const saved of editables || []) {
      const element = resolvePath(saved.path);
      if (!(element instanceof HTMLElement) || !element.isContentEditable) continue;
      try {
        if (element.innerHTML !== saved.html) element.innerHTML = saved.html;
        emitInput(element);
      } catch {}
    }
  }

  function restoreScroll(scroll) {
    if (!scroll) return;
    try { window.scrollTo(scroll.windowX || 0, scroll.windowY || 0); } catch {}
    for (const saved of scroll.elements || []) {
      const element = resolvePath(saved.path);
      if (!element) continue;
      try { element.scrollTo({ top: saved.top || 0, left: saved.left || 0, behavior: "instant" }); } catch {
        element.scrollTop = saved.top || 0;
        element.scrollLeft = saved.left || 0;
      }
    }
  }

  function restoreFocusSelection(saved) {
    if (!saved) return;
    try { resolvePath(saved.focus)?.focus?.({ preventScroll: true }); } catch {}
    const anchor = resolveNodePoint(saved.selection?.anchor);
    const focus = resolveNodePoint(saved.selection?.focus);
    if (!anchor || !focus) return;
    try {
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(anchor.node, anchor.offset);
      range.setEnd(focus.node, focus.offset);
      selection.addRange(range);
    } catch {}
  }

  function restoreMedia(items) {
    for (const saved of items || []) {
      const element = resolvePath(saved.path);
      if (!(element instanceof HTMLMediaElement)) continue;
      try {
        element.currentTime = saved.currentTime || 0;
        element.volume = saved.volume ?? 1;
        element.muted = Boolean(saved.muted);
        element.playbackRate = saved.playbackRate || 1;
        if (!saved.paused) element.play().catch(() => undefined);
        else element.pause();
      } catch {}
    }
  }

  function restoreUiState(ui) {
    for (const saved of ui?.details || []) {
      const element = resolvePath(saved.path);
      if (element instanceof HTMLDetailsElement) element.open = Boolean(saved.open);
    }
    for (const saved of ui?.dialogs || []) {
      const element = resolvePath(saved.path);
      if (!(element instanceof HTMLDialogElement)) continue;
      try {
        if (saved.open && !element.open) element.show?.();
        if (!saved.open && element.open) element.close?.();
      } catch {
        element.toggleAttribute("open", Boolean(saved.open));
      }
    }
  }

  function restoreHistory(saved) {
    if (!saved?.url) return;
    try {
      const current = new URL(location.href);
      const target = new URL(saved.url);
      if (current.origin === target.origin && current.pathname === target.pathname && current.search === target.search) {
        history.replaceState(saved.state, "", target.href);
      }
    } catch {}
  }

  function enabledCategory(categories, only, key) {
    return Boolean(categories?.[key]) && (!only || only.has(key));
  }

  function applyDom(snapshot, categories, onlyCategories) {
    const dom = snapshot?.dom;
    if (!dom) return;
    let only = Array.isArray(onlyCategories) && onlyCategories.length ? new Set(onlyCategories) : null;

    if (!isTop) {
      if (!categories?.iframes) return;
      if (only?.has("iframes")) only = null;
    } else if (only?.has("iframes")) {
      return;
    }

    if (enabledCategory(categories, only, "historyState")) restoreHistory(dom.history);
    if (enabledCategory(categories, only, "formInputs")) restoreControls(dom.controls);
    if (enabledCategory(categories, only, "contentEditable")) restoreEditables(dom.editables);
    if (enabledCategory(categories, only, "uiState")) restoreUiState(dom.ui);
    if (enabledCategory(categories, only, "media")) restoreMedia(dom.media);
    if (enabledCategory(categories, only, "scroll")) restoreScroll(dom.scroll);
    if (enabledCategory(categories, only, "focusSelection")) restoreFocusSelection(dom.focusSelection);
  }

  async function applySnapshot(snapshot, categories, onlyCategories) {
    if (!snapshot) return;
    restoringUntil = Date.now() + 1800;

    let pageOnly = onlyCategories;
    if (!isTop && Array.isArray(onlyCategories) && onlyCategories.includes("iframes")) pageOnly = null;
    if (!isTop && !categories?.iframes) return;
    if (isTop && Array.isArray(onlyCategories) && onlyCategories.includes("iframes")) pageOnly = ["__none__"];

    const restorePage = () => postToPage("RESTORE_PAGE_STATE", {
      page: snapshot.page,
      categories,
      onlyCategories: pageOnly
    }, 600);
    const firstPageRestore = await restorePage();
    if (firstPageRestore === null) setTimeout(restorePage, 250);

    const apply = () => applyDom(snapshot, categories, onlyCategories);
    apply();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", apply, { once: true });
    }
    for (const delay of [300, 1000, 2200]) {
      setTimeout(() => {
        if (enabledCategory(categories, null, "scroll")) restoreScroll(snapshot.dom?.scroll);
        if (delay <= 1000) applyDom(snapshot, categories, onlyCategories);
      }, delay);
    }
    setTimeout(() => scheduleCapture(100), 2300);
  }

  async function requestRestore(force = false, onlyCategories = null) {
    const response = await runtimeMessage({
      type: "RESTORE_REQUEST",
      url: location.href,
      framePath: framePath(),
      force
    });
    if (!response) return;
    settings = response.settings || settings;
    if (response.shouldRestore && response.snapshot) {
      await applySnapshot(response.snapshot, settings.categories, onlyCategories);
    }
  }

  function installCaptureListeners() {
    const changed = () => scheduleCapture(550);
    for (const eventName of ["input", "change", "keyup", "paste", "cut", "drop", "mouseup", "pointerup", "play", "pause", "seeked", "ratechange", "volumechange", "toggle"] ) {
      document.addEventListener(eventName, changed, true);
    }
    document.addEventListener("scroll", (event) => {
      if (event.target instanceof Element) scrolledElements.add(event.target);
      scheduleCapture(450);
    }, true);

    const observer = new MutationObserver(() => scheduleCapture(900));
    const startObserver = () => {
      if (!document.documentElement) return;
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["open", "checked", "selected", "aria-expanded"]
      });
    };
    if (document.documentElement) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver, { once: true });

    setInterval(() => {
      if (document.visibilityState !== "hidden") scheduleCapture(50);
    }, 2200);

    window.addEventListener("pagehide", () => captureNow(true), true);
    window.addEventListener("beforeunload", () => captureNow(true), true);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") captureNow(true);
      else scheduleCapture(250);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "CAPTURE_NOW") {
      captureNow(Boolean(message.immediate));
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RESTORE_NOW") {
      requestRestore(true, message.onlyCategories || null).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  (async () => {
    await requestRestore(false, null);
    captureEnabled = true;
    installCaptureListeners();
    scheduleCapture(600);
  })();
})();
