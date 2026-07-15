"use strict";

(() => {
  if (window.__TAB_RESTORE_PAGE_BRIDGE__) return;
  window.__TAB_RESTORE_PAGE_BRIDGE__ = true;

  const FROM_CONTENT = "TAB_RESTORE_CONTENT";
  const FROM_PAGE = "TAB_RESTORE_PAGE";
  const MAX_STORAGE_CHARS = 1_500_000;
  const MAX_EDITOR_CHARS = 4_000_000;
  const MAX_GLOBAL_CHARS = 300_000;
  const baselineGlobals = new Set(Object.getOwnPropertyNames(window));
  const trackedMonacoEditors = new Set();
  let monacoHooked = false;

  const ignoredGlobals = new Set([
    "window", "self", "top", "parent", "frames", "document", "location", "history",
    "navigator", "screen", "performance", "localStorage", "sessionStorage", "indexedDB",
    "caches", "crypto", "console", "chrome", "trustedTypes", "scheduler", "speechSynthesis",
    "React", "ReactDOM", "Vue", "angular", "jQuery", "$", "webpackJsonp", "monaco", "ace"
  ]);

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
    if (element.id) return `#${cssEscape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.localName;
      if (!part) break;
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((sibling) => sibling.localName === current.localName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
      if (parts.length >= 8) break;
    }
    return parts.join(" > ");
  }

  function safeQuery(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function readStorage(storage) {
    const output = {};
    let size = 0;
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key == null) continue;
        const value = storage.getItem(key);
        size += key.length + (value?.length || 0);
        if (size > MAX_STORAGE_CHARS) break;
        output[key] = value;
      }
    } catch {
      return output;
    }
    return output;
  }

  function writeStorage(storage, values) {
    if (!values || typeof values !== "object") return;
    try {
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" || value === null) storage.setItem(key, value ?? "");
      }
    } catch {
      // Quota and access failures are isolated to the current origin.
    }
  }

  function pack(value, depth, seen, budget) {
    if (budget.remaining <= 0) return undefined;
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      const safeValue = typeof value === "number" && !Number.isFinite(value) ? null : value;
      budget.remaining -= typeof safeValue === "string" ? safeValue.length : 8;
      return safeValue;
    }
    if (typeof value === "bigint") return { __tabRestoreType: "bigint", value: String(value) };
    if (typeof value === "undefined") return { __tabRestoreType: "undefined" };
    if (typeof value === "function" || typeof value === "symbol" || depth > 4) return undefined;
    if (value instanceof Node || value instanceof Window || value instanceof EventTarget) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (value instanceof Date) return { __tabRestoreType: "date", value: value.toISOString() };
    if (value instanceof RegExp) return { __tabRestoreType: "regexp", source: value.source, flags: value.flags };
    if (value instanceof Map) {
      const entries = [];
      let count = 0;
      for (const [key, item] of value) {
        if (count++ >= 100) break;
        const packedKey = pack(key, depth + 1, seen, budget);
        const packedItem = pack(item, depth + 1, seen, budget);
        if (packedKey !== undefined && packedItem !== undefined) entries.push([packedKey, packedItem]);
      }
      return { __tabRestoreType: "map", entries };
    }
    if (value instanceof Set) {
      const values = [];
      let count = 0;
      for (const item of value) {
        if (count++ >= 100) break;
        const packed = pack(item, depth + 1, seen, budget);
        if (packed !== undefined) values.push(packed);
      }
      return { __tabRestoreType: "set", values };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 300).map((item) => pack(item, depth + 1, seen, budget));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const output = {};
    for (const key of Object.keys(value).slice(0, 250)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      let packed;
      try {
        packed = pack(value[key], depth + 1, seen, budget);
      } catch {
        continue;
      }
      if (packed !== undefined) output[key] = packed;
      if (budget.remaining <= 0) break;
    }
    return output;
  }

  function revive(value) {
    if (!value || typeof value !== "object") return value;
    if (value.__tabRestoreType === "undefined") return undefined;
    if (value.__tabRestoreType === "bigint") {
      try { return BigInt(value.value); } catch { return value.value; }
    }
    if (value.__tabRestoreType === "date") return new Date(value.value);
    if (value.__tabRestoreType === "regexp") return new RegExp(value.source, value.flags);
    if (value.__tabRestoreType === "map") return new Map(value.entries.map(([key, item]) => [revive(key), revive(item)]));
    if (value.__tabRestoreType === "set") return new Set(value.values.map(revive));
    if (Array.isArray(value)) return value.map(revive);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      output[key] = revive(item);
    }
    return output;
  }

  function collectGlobals() {
    const globals = {};
    let total = 0;
    for (const key of Object.getOwnPropertyNames(window)) {
      if (total >= MAX_GLOBAL_CHARS || Object.keys(globals).length >= 200) break;
      if (baselineGlobals.has(key) || ignoredGlobals.has(key) || /^on[a-z]+$/i.test(key) || /^webkit/i.test(key)) continue;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(window, key);
      } catch {
        continue;
      }
      if (!descriptor || !("value" in descriptor) || descriptor.writable === false) continue;
      const budget = { remaining: Math.min(80_000, MAX_GLOBAL_CHARS - total) };
      let packed;
      try {
        packed = pack(descriptor.value, 0, new WeakSet(), budget);
      } catch {
        continue;
      }
      if (packed === undefined) continue;
      let length = 0;
      try { length = JSON.stringify(packed).length; } catch { continue; }
      if (length > 80_000 || total + length > MAX_GLOBAL_CHARS) continue;
      globals[key] = packed;
      total += length;
    }
    return globals;
  }

  function mergeExisting(target, source, depth = 0) {
    if (depth > 5 || source === null || typeof source !== "object") return source;
    if (Array.isArray(target) && Array.isArray(source)) {
      target.splice(0, target.length, ...source);
      return target;
    }
    if (
      target && source &&
      Object.getPrototypeOf(target) === Object.prototype &&
      Object.getPrototypeOf(source) === Object.prototype
    ) {
      for (const [key, value] of Object.entries(source)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) continue;
        target[key] = mergeExisting(target[key], value, depth + 1);
      }
      return target;
    }
    return source;
  }

  function restoreGlobals(globals) {
    if (!globals || typeof globals !== "object") return;
    for (const [key, packed] of Object.entries(globals)) {
      if (ignoredGlobals.has(key) || ["__proto__", "prototype", "constructor"].includes(key)) continue;
      try {
        const value = revive(packed);
        const descriptor = Object.getOwnPropertyDescriptor(window, key);
        if (!descriptor || descriptor.writable !== false) {
          window[key] = mergeExisting(window[key], value);
        }
      } catch {
        // A single read-only or guarded global must not stop the remaining restore.
      }
    }
  }

  function hookMonaco() {
    if (monacoHooked || !window.monaco?.editor?.create) return;
    try {
      const originalCreate = window.monaco.editor.create;
      if (originalCreate.__tabRestoreWrapped) {
        monacoHooked = true;
        return;
      }
      const wrapped = function (...args) {
        const editor = Reflect.apply(originalCreate, this, args);
        trackedMonacoEditors.add(editor);
        return editor;
      };
      Object.defineProperty(wrapped, "__tabRestoreWrapped", { value: true });
      window.monaco.editor.create = wrapped;
      monacoHooked = true;
    } catch {
      // Some sites freeze their editor namespace.
    }
  }

  function limitedEditorValue(value) {
    const text = String(value ?? "");
    return text.length > MAX_EDITOR_CHARS ? text.slice(0, MAX_EDITOR_CHARS) : text;
  }

  function codeMirror6View(element) {
    const content = element.querySelector?.(".cm-content");
    return element.cmView?.view || element.view || element.__view || content?.cmView?.view || null;
  }

  function collectEditors() {
    hookMonaco();
    const output = { monaco: [], monacoViews: [], codeMirror5: [], codeMirror6: [], ace: [] };

    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      output.monaco = models.slice(0, 30).map((model, index) => ({
        index,
        uri: model.uri?.toString?.() || "",
        value: limitedEditorValue(model.getValue())
      }));
      output.monacoViews = Array.from(trackedMonacoEditors).slice(0, 30).map((editor, index) => ({
        index,
        modelUri: editor.getModel?.()?.uri?.toString?.() || "",
        viewState: editor.saveViewState?.() || null
      }));
    } catch {}

    document.querySelectorAll(".CodeMirror").forEach((element, index) => {
      if (index >= 50) return;
      const editor = element.CodeMirror;
      if (!editor?.getValue) return;
      try {
        output.codeMirror5.push({
          index,
          selector: selectorFor(element),
          value: limitedEditorValue(editor.getValue()),
          cursor: editor.getCursor?.() || null,
          scroll: editor.getScrollInfo?.() || null
        });
      } catch {}
    });

    document.querySelectorAll(".cm-editor").forEach((element, index) => {
      if (index >= 50) return;
      const view = codeMirror6View(element);
      if (!view?.state?.doc) return;
      try {
        output.codeMirror6.push({
          index,
          selector: selectorFor(element),
          value: limitedEditorValue(view.state.doc.toString()),
          anchor: view.state.selection?.main?.anchor ?? 0,
          head: view.state.selection?.main?.head ?? 0
        });
      } catch {}
    });

    document.querySelectorAll(".ace_editor").forEach((element, index) => {
      if (index >= 50) return;
      const editor = element.env?.editor;
      if (!editor?.getValue) return;
      try {
        output.ace.push({
          index,
          selector: selectorFor(element),
          value: limitedEditorValue(editor.getValue()),
          cursor: editor.getCursorPosition?.() || null,
          scrollTop: editor.session?.getScrollTop?.() || 0,
          scrollLeft: editor.session?.getScrollLeft?.() || 0
        });
      } catch {}
    });
    return output;
  }

  function bySelectorOrIndex(selector, query, index) {
    return safeQuery(selector) || document.querySelectorAll(query)[index] || null;
  }

  function restoreEditors(editors) {
    if (!editors) return;
    hookMonaco();
    try {
      const models = window.monaco?.editor?.getModels?.() || [];
      for (const saved of editors.monaco || []) {
        const model = models.find((candidate) => candidate.uri?.toString?.() === saved.uri) || models[saved.index];
        if (model?.getValue && model.getValue() !== saved.value) model.setValue(saved.value);
      }
      for (const saved of editors.monacoViews || []) {
        const editor = Array.from(trackedMonacoEditors).find(
          (candidate) => candidate.getModel?.()?.uri?.toString?.() === saved.modelUri
        ) || Array.from(trackedMonacoEditors)[saved.index];
        if (editor && saved.viewState) editor.restoreViewState?.(saved.viewState);
      }
    } catch {}

    for (const saved of editors.codeMirror5 || []) {
      const element = bySelectorOrIndex(saved.selector, ".CodeMirror", saved.index);
      const editor = element?.CodeMirror;
      try {
        if (editor?.getValue && editor.getValue() !== saved.value) editor.setValue(saved.value);
        if (saved.cursor) editor?.setCursor?.(saved.cursor);
        if (saved.scroll) editor?.scrollTo?.(saved.scroll.left, saved.scroll.top);
      } catch {}
    }

    for (const saved of editors.codeMirror6 || []) {
      const element = bySelectorOrIndex(saved.selector, ".cm-editor", saved.index);
      const view = element && codeMirror6View(element);
      try {
        if (!view?.state?.doc) continue;
        const current = view.state.doc.toString();
        if (current !== saved.value) {
          view.dispatch({ changes: { from: 0, to: current.length, insert: saved.value } });
        }
        view.dispatch({ selection: { anchor: saved.anchor, head: saved.head } });
      } catch {}
    }

    for (const saved of editors.ace || []) {
      const element = bySelectorOrIndex(saved.selector, ".ace_editor", saved.index);
      const editor = element?.env?.editor;
      try {
        if (editor?.getValue && editor.getValue() !== saved.value) editor.setValue(saved.value, -1);
        if (saved.cursor) editor?.moveCursorToPosition?.(saved.cursor);
        editor?.session?.setScrollTop?.(saved.scrollTop || 0);
        editor?.session?.setScrollLeft?.(saved.scrollLeft || 0);
      } catch {}
    }
  }

  function collectPageState() {
    return {
      storage: {
        local: readStorage(window.localStorage),
        session: readStorage(window.sessionStorage)
      },
      globals: collectGlobals(),
      editors: collectEditors()
    };
  }

  function restorePageState(payload, categories, onlyCategories) {
    if (!payload) return;
    const only = Array.isArray(onlyCategories) && onlyCategories.length ? new Set(onlyCategories) : null;
    const enabled = (key) => Boolean(categories?.[key]) && (!only || only.has(key));

    if (enabled("siteStorage")) {
      writeStorage(window.localStorage, payload.storage?.local);
      writeStorage(window.sessionStorage, payload.storage?.session);
    }
    if (enabled("pageVariables")) restoreGlobals(payload.globals);
    if (enabled("editorCode")) {
      restoreEditors(payload.editors);
      for (const delay of [250, 900, 2200, 5000]) {
        setTimeout(() => restoreEditors(payload.editors), delay);
      }
    }
    window.dispatchEvent(new CustomEvent("tab-restore:applied", { detail: { categories: [...(only || [])] } }));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== FROM_CONTENT) return;
    const { requestId, type, payload } = event.data;
    if (type === "CAPTURE_PAGE_STATE") {
      let result = null;
      try { result = collectPageState(); } catch {}
      window.postMessage({ source: FROM_PAGE, requestId, type: "CAPTURE_RESULT", payload: result }, "*");
    }
    if (type === "RESTORE_PAGE_STATE") {
      try {
        restorePageState(payload?.page, payload?.categories, payload?.onlyCategories);
      } catch {}
      window.postMessage({ source: FROM_PAGE, requestId, type: "RESTORE_RESULT", payload: true }, "*");
    }
  });

  setInterval(hookMonaco, 700);
})();
