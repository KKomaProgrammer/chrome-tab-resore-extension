"use strict";

const CATEGORY_GROUPS = [
  {
    title: "입력 및 편집",
    items: [
      ["editorCode", "에디터 코드", "Monaco · CodeMirror · Ace"],
      ["formInputs", "입력 내용", "입력창 · 선택 · 체크 상태"],
      ["contentEditable", "웹 편집 영역", "리치 텍스트 · 작성 중인 글"]
    ]
  },
  {
    title: "화면 및 탐색",
    items: [
      ["scroll", "스크롤 위치", "페이지 · 내부 스크롤 영역"],
      ["focusSelection", "포커스와 선택", "커서 · 텍스트 선택 범위"],
      ["media", "미디어 재생", "재생 위치 · 음량 · 속도"],
      ["uiState", "화면 요소 상태", "펼침 영역 · 대화상자"],
      ["historyState", "페이지 이동 상태", "주소 · SPA 기록 상태"]
    ]
  },
  {
    title: "사이트 데이터",
    items: [
      ["iframes", "iframe", "각 프레임을 독립적으로 복구"],
      ["siteStorage", "사이트 저장소", "localStorage · sessionStorage"],
      ["pageVariables", "페이지 변수", "복구 가능한 전역 변수"]
    ]
  }
];

const SHORTCUTS = [
  ["restore", "restore-current", "저장 상태 복구"],
  ["reload", "reload-and-restore", "저장 후 새로고침"]
];

const $ = (selector) => document.querySelector(selector);
let state = null;
let feedbackTimer = null;

function message(payload) {
  return chrome.runtime.sendMessage(payload);
}

function switchControl(checked, label, onChange) {
  const wrapper = document.createElement("label");
  wrapper.className = "switch small";
  wrapper.setAttribute("aria-label", label);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span");
  track.className = "switch-track";
  wrapper.append(input, track);
  return wrapper;
}

function settingRow(item) {
  const [key, title, detail] = item;
  const row = document.createElement("div");
  row.className = "setting-row";
  const label = document.createElement("div");
  label.className = "setting-label";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = detail;
  label.append(strong, span);
  row.append(label, switchControl(state.settings.categories[key], title, async (checked) => {
    state.settings.categories[key] = checked;
    await message({
      type: "UPDATE_SETTINGS",
      patch: { categories: { [key]: checked } },
      restoreNow: checked,
      onlyCategories: [key]
    });
    showFeedback(checked ? `${title} 복구 적용` : `${title} 복구 중지`);
  }));
  return row;
}

function renderCategories() {
  const container = $("#categoryGroups");
  container.replaceChildren();
  for (const group of CATEGORY_GROUPS) {
    const section = document.createElement("section");
    section.className = "section";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h2");
    title.textContent = group.title;
    heading.append(title);
    section.append(heading, ...group.items.map(settingRow));
    container.append(section);
  }
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const commandMap = new Map(commands.map((command) => [command.name, command.shortcut || "미지정"]));
  const container = $("#shortcutRows");
  container.replaceChildren();

  for (const [settingKey, commandName, title] of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const name = document.createElement("div");
    name.className = "shortcut-name";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const edit = document.createElement("button");
    edit.className = "edit-shortcut";
    edit.type = "button";
    edit.textContent = "수정";
    edit.addEventListener("click", () => message({ type: "OPEN_SHORTCUTS" }));
    name.append(strong, edit);

    const controls = document.createElement("div");
    controls.className = "shortcut-controls";
    const key = document.createElement("kbd");
    key.textContent = commandMap.get(commandName) || "미지정";
    controls.append(key, switchControl(state.settings.shortcuts[settingKey], title, async (checked) => {
      state.settings.shortcuts[settingKey] = checked;
      await message({ type: "UPDATE_SETTINGS", patch: { shortcuts: { [settingKey]: checked } } });
    }));
    row.append(name, controls);
    container.append(row);
  }
}

function relativeTime(timestamp) {
  if (!timestamp) return "저장 기록 없음";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "방금 저장됨";
  if (seconds < 60) return `${seconds}초 전 저장`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전 저장`;
  const hours = Math.round(minutes / 60);
  return `${hours}시간 전 저장`;
}

function updateStatus() {
  const status = $("#saveStatus");
  const timestamp = state.current?.updatedAt || state.latest?.updatedAt;
  status.textContent = relativeTime(timestamp);
  status.classList.toggle("saved", Boolean(timestamp));
  $("#saveNow").disabled = !state.restorable;
  $("#restoreNow").disabled = !state.restorable || !timestamp;
}

function showFeedback(text) {
  clearTimeout(feedbackTimer);
  $("#feedback").textContent = text;
  feedbackTimer = setTimeout(() => { $("#feedback").textContent = ""; }, 2200);
}

async function refreshData() {
  state = await message({ type: "GET_POPUP_DATA" });
  $("#autoRestore").checked = state.settings.autoRestore;
  $("#shortcutsEnabled").checked = state.settings.shortcuts.enabled;
  renderCategories();
  await renderShortcuts();
  updateStatus();
}

$("#autoRestore").addEventListener("change", async (event) => {
  state.settings.autoRestore = event.target.checked;
  await message({
    type: "UPDATE_SETTINGS",
    patch: { autoRestore: event.target.checked },
    restoreNow: event.target.checked
  });
  showFeedback(event.target.checked ? "자동 복구 적용" : "자동 복구 중지");
});

$("#shortcutsEnabled").addEventListener("change", async (event) => {
  state.settings.shortcuts.enabled = event.target.checked;
  await message({ type: "UPDATE_SETTINGS", patch: { shortcuts: { enabled: event.target.checked } } });
  showFeedback(event.target.checked ? "단축키 사용" : "단축키 중지");
});

$("#saveNow").addEventListener("click", async () => {
  const button = $("#saveNow");
  button.disabled = true;
  const result = await message({ type: "SAVE_ACTIVE" });
  showFeedback(result?.ok ? "현재 상태 저장 완료" : "이 페이지에서는 저장할 수 없음");
  setTimeout(refreshData, 300);
});

$("#restoreNow").addEventListener("click", async () => {
  const result = await message({ type: "RESTORE_ACTIVE" });
  showFeedback(result?.ok ? "저장 상태 복구 완료" : "복구할 상태 없음");
});

refreshData().catch(() => {
  $("#saveStatus").textContent = "연결 실패";
});
