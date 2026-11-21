import { findAnchor, mainHistory } from "./notebook.mjs";
import { renderMarkdown, selectionSource, sourceRange } from "./markdown-dom.mjs";
import { setupPdfReview } from "./pdf-review-ui.mjs";
import { setupCommentChats } from "./comment-chat.mjs";

const api = window.notebook;
const get = (id) => document.getElementById(id);
const actionButton = (name) => document.querySelector(`[data-action="${name}"]`);
const node = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};
const button = (text, action, className = "") => {
  const element = node("button", className, text);
  element.type = "button";
  if (action) element.dataset.action = action;
  return element;
};

let state;
let libraryItems = [];
let libraryBusy = false;
let activeView = "document";
let activeBlock;
let selectedText = null;
let selectedAnswer = null;
let currentBranchId;
let canvasSelection;
let notesVisible = true;
let editing = false;
let currentTurn;
let pendingFrame = false;
let settings;
let account = {};
let accountCheck = 0;
let settingsBusy = false;
const logins = new Set();
let statusTimer;
let editorSave;
const sideDrafts = new Map();
const mainDrafts = new Map();
const draftFiles = new Map();
const stagingFiles = new Set();
const maxDraftFiles = 6;

const currentBranch = () => state.branches.find((branch) => branch.id === currentBranchId);
const anchorLabel = (reference) => reference.label || reference.quote;
const branchTitle = (branch) => branch.turns[0]?.question || anchorLabel(branch.anchor) || "新分支";
const currentProfile = () => settings?.profiles.find((item) => item.id === settings.active[settings.provider]);
const providerName = (provider) => provider === "claude" ? "Claude" : "GPT";
const sourceLabel = (source) => [providerName(source?.provider), source?.model, source?.effort].filter(Boolean).join(" · ");
const draftKey = (kind) => kind === "side" ? currentBranchId : state?.id;

function say(message) {
  const status = get("status");
  clearTimeout(statusTimer);
  status.textContent = message;
  status.hidden = false;
  statusTimer = setTimeout(() => { status.hidden = true; }, 7500);
}

function accept(next) {
  if (state && (next.id !== state.id || (next.revision || 0) < (state.revision || 0))) return;
  state = next;
}

async function change(action) {
  accept(await api.change({ ...action, notebookId: state.id }));
}

function renderLibrary() {
  get("notebook-list").replaceChildren(...libraryItems.map((item) => {
    const selected = item.id === state?.id;
    const title = selected ? state.title : item.title;
    const control = button(title, "open-notebook", "notebook-item");
    control.dataset.notebookId = item.id;
    control.title = title;
    if (selected) control.setAttribute("aria-current", "page");
    return control;
  }));
}

async function switchNotebook(open) {
  if (editing) throw new Error("请先保存正在编辑的正文。");
  if (libraryBusy) return;
  libraryBusy = true;
  try {
    const result = await open();
    if (state) mainDrafts.set(state.id, get("main-question").value);
    state = result.state;
    libraryItems = result.items;
    activeBlock = state.blocks.find((item) => !item.removed)?.id;
    selectedText = selectedAnswer = currentBranchId = canvasSelection = undefined;
    get("main-question").value = mainDrafts.get(state.id) || "";
    chatOpen(false);
    activeView = "document";
    renderDocument();
    updateView();
    renderPending();
    window.scrollTo(0, 0);
  } finally {
    libraryBusy = false;
  }
}

function captureSelection() {
  const selection = window.getSelection();
  const tools = get("selection-tools");
  tools.hidden = true;
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  const block = parent?.closest(".body-text");
  const answer = parent?.closest(".answer-text");
  const text = range.toString();
  if (!text.trim()) return;
  if (block) {
    const mapped = selectionSource(block, range);
    const source = state.blocks.find((item) => item.id === block.dataset.blockId)?.text;
    if (!mapped || !source) return;
    activeBlock = block.dataset.blockId;
    selectedText = { blockId: activeBlock, start: mapped.start, quote: source.slice(mapped.start, mapped.end),
      label: selection.toString() };
    const rect = Array.from(range.getClientRects()).at(-1);
    const headerBottom = document.querySelector(".app-header").getBoundingClientRect().bottom;
    if (rect?.height && rect.bottom > headerBottom && rect.top < innerHeight && !editing) {
      tools.hidden = false;
      tools.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tools.offsetWidth - 8))}px`;
      const above = rect.top - tools.offsetHeight - 5;
      tools.style.top = `${above > headerBottom ? above : rect.bottom + 5}px`;
    }
  }
  if (answer) selectedAnswer = { turnId: answer.dataset.turnId, text: selection.toString().trim() };
}

function anchor(requireSelection = false) {
  const block = state.blocks.find((item) => item.id === activeBlock && !item.removed && item.text.trim()) ||
    state.blocks.find((item) => !item.removed && item.text.trim());
  if (block && selectedText?.blockId === block.id) {
    const start = findAnchor(block.text, selectedText);
    if (start !== null) return { ...selectedText, start };
  }
  if (!requireSelection && block) return { blockId: block.id, start: 0, quote: block.text };
  throw new Error("请先选中正文里的文字。");
}

function locate(reference) {
  const block = state.blocks.find((item) => item.id === reference.blockId);
  const start = block && !block.removed ? findAnchor(block.text, reference) : null;
  if (start === null) {
    say("原文已改动，批注保留了当时的引文。");
    return;
  }
  if (editing) throw new Error("请先保存正文。");
  const element = Array.from(get("blocks").querySelectorAll(".body-text"))
    .find((item) => item.dataset.blockId === reference.blockId);
  const range = element && sourceRange(element, start, start + reference.quote.length);
  if (!range) {
    say("这处引文当前没有可见文字。");
    return;
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  captureSelection();
  element.scrollIntoView({ block: "center" });
}

function markedText(element, block, notes) {
  const marks = [
    ...block.marks,
    ...notes.map((note) => ({ ...note.anchor, style: "note" }))
  ].flatMap((mark) => {
    const start = findAnchor(block.text, mark);
    return start === null ? [] : [{ start, end: start + mark.quote.length, style: mark.style }];
  });
  renderMarkdown(element, block.text, { literal: block.kind === "question", marks });
}

function annotation(note) {
  const card = node("article", "annotation");
  card.dataset.noteId = note.id;
  const label = anchorLabel(note.anchor);
  const quote = button(label, "locate-note", "quote-button");
  quote.setAttribute("aria-label", `定位原文：${label}`);
  const pin = button(note.pinned ? "已固定" : "固定为记忆", "pin-note");
  pin.setAttribute("aria-pressed", String(note.pinned));
  const commands = node("div", "annotation-actions");
  commands.append(pin, button("编辑", "edit-note"), button("删除", "delete-note"));
  const content = node("div", "markdown-content note-content");
  renderMarkdown(content, note.text);
  card.append(node("strong", "author", note.author), quote, content, commands);
  const notebookId = state.id;
  commentChats.mount(card, {
    key: `note:${notebookId}:${note.id}`,
    target: () => ({ notebookId, noteId: note.id }),
    turns: () => (state.id === notebookId ? state.notes.find((item) => item.id === note.id)?.turns : note.turns) || [],
    receive: ({ notebook }) => accept(notebook)
  });
  return card;
}

function attachmentChip(ref, kind) {
  if (!kind) {
    const link = button("", "open-attachment", "attachment-chip");
    link.dataset.attachmentId = ref.id;
    link.title = ref.name;
    link.append(node("span", "", ref.name));
    return link;
  }
  const chip = node("span", "attachment-chip");
  const name = node("span", "", ref.name);
  name.title = ref.name;
  const remove = button("×", "remove-attachment", "remove-file");
  remove.dataset.attachmentId = ref.id;
  remove.dataset.composer = kind;
  remove.setAttribute("aria-label", `移除附件 ${ref.name}`);
  remove.disabled = currentTurn?.fileKey === draftKey(kind);
  chip.append(name, remove);
  return chip;
}

function sentAttachments(refs = []) {
  const group = node("div", "attachments sent");
  group.hidden = !refs.length;
  group.append(...refs.map((ref) => attachmentChip(ref)));
  return group;
}

function renderMemories(container, fieldset, selectedIds) {
  const pinned = state.notes.filter((note) => note.pinned);
  get(fieldset).hidden = !pinned.length;
  get(container).replaceChildren(...pinned.map((note) => {
    const label = node("label");
    const check = node("input");
    check.type = "checkbox";
    check.dataset.memory = note.id;
    check.checked = selectedIds.includes(note.id);
    label.append(check, node("span", "", note.text));
    return label;
  }));
}

function renderMainContext() {
  const history = mainHistory(state);
  const memoryIds = state.mainMemoryIds || [];
  get("main-context-count").textContent = `${history.length} 轮 · ${memoryIds.length} 条记忆`;
  renderMemories("main-memory-list", "main-memory-choices", memoryIds);
}

function renderDocument() {
  const title = get("document-title");
  title.replaceChildren();
  if (editing) {
    const input = node("input");
    input.id = "title-input";
    input.maxLength = 160;
    input.value = state.title;
    input.setAttribute("aria-label", "笔记标题");
    title.append(input);
  } else {
    title.textContent = state.title;
  }
  const origin = state.origin;
  get("notebook-origin").hidden = !origin;
  if (origin) {
    get("origin-reference").textContent = [origin.reference, origin.title].filter(Boolean).join(" · ");
    get("origin-quote").textContent = origin.quote;
    get("origin-quote").hidden = !origin.quote;
    renderMarkdown(get("origin-comment"), origin.text);
  }
  const fragments = document.createDocumentFragment();
  for (const block of state.blocks) {
    const attached = state.notes.filter((note) => note.anchor.blockId === block.id);
    const paragraph = node("article", `paper-block${block.kind === "question" ? " is-question" : ""}`);
    if (block.removed) {
      if (!attached.length) continue;
      paragraph.append(node("p", "removed-block", "原段落已移除"));
    } else if (editing) {
      const input = node("textarea", "block-editor");
      input.dataset.blockId = block.id;
      input.value = block.text;
      input.maxLength = 60_000;
      input.rows = Math.max(2, Math.min(14, Math.ceil(block.text.length / 50)));
      input.setAttribute("aria-label", "编辑段落");
      const tools = node("div", "block-controls");
      const remove = button("移除段落", "remove-block");
      remove.setAttribute("aria-pressed", "false");
      if (["question", "reply"].includes(block.kind)) {
        const include = node("input", "include-block");
        include.type = "checkbox";
        include.checked = block.included !== false;
        const label = node("label");
        label.append(include, "用于主对话");
        tools.append(label);
      }
      tools.append(remove);
      paragraph.append(input, tools);
    } else {
      const element = block.kind === "question"
        ? node("h2", "body-text") : node("div", "body-text markdown-content");
      element.dataset.blockId = block.id;
      markedText(element, block, attached);
      if (block.source) paragraph.append(node("p", "reply-source", sourceLabel(block.source)));
      if (block.included === false) paragraph.append(node("span", "context-excluded", "仅显示"));
      paragraph.append(element);
    }
    if (!block.removed && block.attachments?.length) paragraph.append(sentAttachments(block.attachments));
    const margin = node("div", "margin-slot");
    margin.append(...attached.map(annotation));
    fragments.append(paragraph, margin);
  }
  get("blocks").replaceChildren(fragments);
  get("note-count").textContent = `${state.notes.length} 条`;
  get("document-grid").classList.toggle("notes-hidden", !notesVisible);
  renderMainContext();
  renderLibrary();
}

function showNotes(visible) {
  notesVisible = visible;
  get("document-grid").classList.toggle("notes-hidden", !visible);
  actionButton("toggle-notes").setAttribute("aria-pressed", String(visible));
}

function updateView() {
  document.body.dataset.view = activeView;
  get("document-view").hidden = activeView !== "document";
  get("canvas-view").hidden = activeView !== "canvas";
  get("pdf-view").hidden = activeView !== "pdf";
  for (const tab of document.querySelectorAll("[data-view]")) {
    if (tab.dataset.view === activeView) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (activeView === "canvas") renderCanvas();
  if (activeView === "pdf") pdfReview.activate();
}

function chatOpen(open) {
  get("side-chat").hidden = !open;
  get("document-layout").classList.toggle("chat-open", open);
  actionButton("ask").setAttribute("aria-expanded", String(open));
}

function renderChat() {
  const branch = currentBranch();
  if (!branch) return;
  const { anchor: reference, context, turns, memoryIds } = branch;
  get("context-quote").textContent = anchorLabel(reference);
  renderMarkdown(get("context-paragraph"), reference.quote === context ? "" : context);
  get("context-count").textContent = `1 段 · ${memoryIds.length} 条记忆`;
  const priorFiles = turns.reduce((sum, turn) => sum + (turn.attachments?.length || 0), 0);
  get("history-count").textContent = `本分支 ${turns.length} 轮已完成问答${priorFiles ? ` · 随对话引用 ${priorFiles} 个附件` : ""}`;
  renderMemories("memory-list", "memory-choices", memoryIds);
  get("side-turns").replaceChildren(...turns.map((turn) => {
    const article = node("article", "side-turn");
    const reply = node("div", "answer-text markdown-content");
    renderMarkdown(reply, turn.answer);
    reply.dataset.turnId = turn.id;
    const controls = node("div", "turn-actions");
    controls.dataset.turnId = turn.id;
    controls.append(button("选中文字存为批注", "extract"), button("编辑回答", "edit-answer"));
    article.append(node("p", "question-bubble", turn.question), sentAttachments(turn.attachments),
      node("p", "reply-source", sourceLabel(turn.source)), reply, controls);
    return article;
  }));
  get("side-question").value = sideDrafts.get(branch.id) || "";
  selectedAnswer = null;
  renderPending();
}

function openChat(branchId) {
  currentBranchId = branchId;
  activeView = "document";
  updateView();
  chatOpen(true);
  renderChat();
  get("side-question").focus();
}

async function openFromSelection(forceNew) {
  const reference = anchor(forceNew);
  let branch = forceNew ? null : state.branches.findLast((item) =>
    item.anchor.blockId === reference.blockId && item.anchor.start === reference.start &&
    item.anchor.quote === reference.quote);
  if (!branch) {
    await change({ type: "create-branch", anchor: reference });
    branch = state.branches.at(-1);
  }
  if (forceNew) {
    canvasSelection = branch.id;
    activeView = "canvas";
    updateView();
  } else {
    openChat(branch.id);
  }
}

function renderCanvas() {
  const layer = get("canvas-nodes");
  const board = get("canvas-board");
  const root = button("", "document-from-canvas", "canvas-node root-node");
  root.append(node("strong", "", state.title), node("small", "", "返回正文"));
  root.style.left = "26px";
  root.style.top = "145px";
  layer.replaceChildren(root);
  get("branch-count").textContent = `${state.branches.length} 条分支`;
  const bounds = [];
  for (const [index, branch] of state.branches.entries()) {
    const point = branch.position ?? { x: 302 + Math.floor(index / 4) * 246, y: 22 + index % 4 * 101 };
    const element = button("", "", "canvas-node");
    element.dataset.branchId = branch.id;
    element.setAttribute("aria-pressed", String(branch.id === canvasSelection));
    element.append(node("strong", "", branchTitle(branch)), node("small", "",
      `${branch.turns.length ? `${providerName(branch.turns.at(-1).source?.provider)} · ` : ""}${branch.turns.length} 轮`));
    let moved = false;
    element.addEventListener("click", (event) => {
      if (moved && event.detail > 0) return;
      canvasSelection = branch.id;
      for (const item of layer.querySelectorAll("[data-branch-id]")) {
        item.setAttribute("aria-pressed", String(item === element));
      }
      showCanvasDetail();
    });
    const move = (position) => {
      element.style.left = `${position.x}px`;
      element.style.top = `${position.y}px`;
    };
    move(point);
    let drag;
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      moved = false;
      drag = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      move({
        x: Math.max(0, Math.min(board.clientWidth - element.offsetWidth, drag.left + dx)),
        y: Math.max(0, Math.min(board.clientHeight - element.offsetHeight, drag.top + dy))
      });
      drawCanvasLinks();
    });
    element.addEventListener("lostpointercapture", () => {
      if (drag && moved) {
        change({ type: "move-branch", id: branch.id, position: { x: element.offsetLeft, y: element.offsetTop } })
          .catch((error) => { say(error.message); renderCanvas(); });
      }
      drag = null;
    });
    layer.append(element);
    bounds.push(point);
  }
  board.style.width = `${Math.max(560, ...bounds.map(({ x }) => x + 250))}px`;
  board.style.height = `${Math.max(435, ...bounds.map(({ y }) => y + 105))}px`;
  drawCanvasLinks();
  showCanvasDetail();
}

function drawCanvasLinks() {
  const layer = get("canvas-nodes");
  const root = layer.querySelector(".root-node");
  const x = root.offsetLeft + root.offsetWidth;
  const y = root.offsetTop + root.offsetHeight / 2;
  const edges = Array.from(layer.querySelectorAll("[data-branch-id]"), (target) => {
    const endX = target.offsetLeft;
    const endY = target.offsetTop + target.offsetHeight / 2;
    const middle = (x + endX) / 2;
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
    edge.setAttribute("d", `M${x},${y} C${middle},${y} ${middle},${endY} ${endX},${endY}`);
    return edge;
  });
  get("canvas-links").replaceChildren(...edges);
}

function showCanvasDetail() {
  const branch = state.branches.find((item) => item.id === canvasSelection);
  get("canvas-detail").hidden = !branch;
  if (branch) {
    get("branch-title").textContent = branchTitle(branch);
    get("branch-quote").textContent = anchorLabel(branch.anchor);
  }
}

function showEditor({ heading, reference, text = "", limit = 60_000, rows = 7, save }) {
  get("editor-heading").textContent = heading;
  get("editor-reference").hidden = !reference;
  get("editor-reference").textContent = reference || "";
  get("editor-text").maxLength = limit;
  get("editor-text").rows = rows;
  get("editor-text").value = text;
  editorSave = save;
  get("editor").showModal();
  get("editor-text").focus();
}

function option(value, label, disabled = false) {
  const item = node("option", "", label);
  item.value = value;
  item.disabled = disabled;
  return item;
}

function renderSettings() {
  const profile = currentProfile();
  if (!profile) return;
  const provider = providerName(profile.provider);
  get("provider-picker").value = profile.provider;
  const accounts = get("account-picker");
  accounts.replaceChildren(...settings.profiles.filter((item) => item.provider === profile.provider)
    .map((item) => option(item.id, item.name)));
  accounts.value = profile.id;
  const status = get("account-status");
  status.textContent = account.message || (account.signedIn ? `${account.plan?.toUpperCase() || "订阅"} · 已登录` : "未登录");
  status.title = account.email || status.textContent;
  document.querySelector(".account").classList.toggle("connected", Boolean(account.signedIn));
  get("login").disabled = logins.has(profile.id);
  get("login").textContent = logins.has(profile.id) ? "登录中" : account.signedIn ? "重新登录" : "登录";
  get("main-prompt-label").textContent = `向 ${provider} 提问`;
  get("chat-provider").textContent = `${provider} · ${profile.name}`;

  const models = account.models || [];
  const fallback = models.find((model) => model.isDefault) || models[0];
  const picker = get("model-picker");
  const defaults = profile.provider === "gpt" && fallback ? `自动 · ${fallback.label}` : fallback?.label || "自动";
  picker.replaceChildren(option("", defaults), ...models.filter((model) => model.id).map((model) => option(model.id, model.label)));
  const selected = profile.model ? models.find((model) => model.id === profile.model) : fallback;
  if (profile.model && !selected) picker.append(option(profile.model, profile.model, true));
  picker.value = profile.model;
  picker.disabled = !models.length || settingsBusy;
  const effort = profile.efforts[profile.model] || "";
  const levels = selected?.efforts || [];
  const effortPicker = get("effort-picker");
  effortPicker.replaceChildren(option("", selected?.defaultEffort ? `自动 · ${selected.defaultEffort}` : "自动"),
    ...levels.map((level) => option(level, level)));
  if (effort && !levels.includes(effort)) effortPicker.append(option(effort, effort, true));
  effortPicker.value = effort;
  effortPicker.disabled = !levels.length || settingsBusy;
  for (const id of ["provider-picker", "account-picker"]) get(id).disabled = settingsBusy;
}

async function refreshAccount() {
  const profile = currentProfile();
  if (!profile) return;
  const serial = ++accountCheck;
  account = { message: "正在检查" };
  renderSettings();
  try {
    const result = await api.account(profile.id);
    if (serial === accountCheck && currentProfile().id === profile.id) account = result;
  } catch (error) {
    if (serial === accountCheck && currentProfile().id === profile.id) {
      account = { message: "暂不可用" };
      say(error.message);
    }
  }
  if (serial === accountCheck) renderSettings();
}

async function changeSetting(action) {
  if (settingsBusy) return;
  const oldProfileId = currentProfile().id;
  settingsBusy = true;
  renderSettings();
  try {
    settings = await api.setSetting(action);
  } finally {
    settingsBusy = false;
    if (currentProfile().id === oldProfileId) renderSettings();
    else void refreshAccount();
  }
}

function renderPending() {
  for (const kind of ["main", "side"]) {
    const pending = get(`${kind}-pending`);
    const visible = currentTurn?.notebookId === state?.id &&
      (kind === "main" ? !currentTurn?.branchId : currentBranchId && currentTurn?.branchId === currentBranchId);
    pending.hidden = !visible;
    pending.replaceChildren();
    if (visible) {
      const header = node("div", "pending-header");
      header.append(node("p", "muted", `${currentTurn.provider} 正在回答`), button("停止", "stop"));
      const output = node("div", "pending-output markdown-content");
      renderMarkdown(output, currentTurn.text);
      pending.append(header, node("p", "question-bubble", currentTurn.question), output);
    }
    const form = get(`${kind}-form`);
    const key = draftKey(kind);
    const refs = draftFiles.get(key) || [];
    const chips = get(`${kind}-attachments`);
    chips.hidden = !refs.length;
    chips.replaceChildren(...refs.map((ref) => attachmentChip(ref, kind)));
    get(`${kind}-question`).required = refs.length === 0;
    const select = form.querySelector('[data-action="choose-files"]');
    select.disabled = !key || editing || stagingFiles.has(key) || currentTurn?.fileKey === key;
    form.querySelector('button[type="submit"]').disabled = Boolean(currentTurn) || editing || stagingFiles.has(key);
  }
  actionButton("delete-chat").disabled = Boolean(currentTurn?.branchId && currentTurn.branchId === currentBranchId);
}

async function sendQuestion(kind) {
  const input = get(`${kind}-question`);
  const question = input.value.trim();
  const notebookId = state.id;
  const fileKey = draftKey(kind);
  if ((!question && !draftFiles.get(fileKey)?.length) || !fileKey || currentTurn || editing ||
      settingsBusy || stagingFiles.has(fileKey)) return;
  const profile = currentProfile();
  const branchId = kind === "side" ? currentBranchId : undefined;
  if (!account.signedIn) {
    await refreshAccount();
    if (state.id !== notebookId || currentProfile().id !== profile.id ||
        (kind === "side" && branchId !== currentBranchId) || currentTurn) return;
    if (!account.signedIn) throw new Error(`请先登录 ${providerName(profile.provider)} 订阅。`);
  }
  if (kind === "side" && !branchId) return;
  const files = draftFiles.get(fileKey) || [];
  if ((!question && !files.length) || stagingFiles.has(fileKey) || editing) return;
  const requestId = crypto.randomUUID();
  currentTurn = { requestId, branchId, notebookId, question: question || "请概述附件的主要内容。",
    fileKey, provider: providerName(profile.provider), text: "" };
  renderPending();
  try {
    accept(await api.send({ requestId, branchId, question, profileId: profile.id, notebookId,
      attachmentIds: files.map((ref) => ref.id) }));
    draftFiles.delete(fileKey);
    if (branchId) {
      if (sideDrafts.get(branchId)?.trim() === question) sideDrafts.delete(branchId);
    } else if (state.id === notebookId) {
      if (input.value.trim() === question) {
        input.value = "";
        mainDrafts.delete(notebookId);
      }
      renderDocument();
    } else if (mainDrafts.get(notebookId)?.trim() === question) {
      mainDrafts.delete(notebookId);
    }
    if (state.id === notebookId) {
      renderChat();
      if (activeView === "canvas") renderCanvas();
    }
  } finally {
    currentTurn = undefined;
    renderPending();
  }
}

async function stageFiles(kind, selected) {
  const key = draftKey(kind);
  const notebookId = state.id;
  if (!key || !selected.length || editing || stagingFiles.has(key) || currentTurn?.fileKey === key) return;
  const existing = draftFiles.get(key) || [];
  const room = maxDraftFiles - existing.length;
  if (!room) throw new Error(`每条消息最多添加 ${maxDraftFiles} 个附件。`);
  stagingFiles.add(key);
  renderPending();
  try {
    const { items, errors } = await api.stageAttachments(selected, room);
    if (kind === "side" && state.id === notebookId && !state.branches.some((branch) => branch.id === key)) {
      await Promise.allSettled(items.map((ref) => api.removeAttachment(ref.id)));
    } else {
      draftFiles.set(key, [...(draftFiles.get(key) || []), ...items]);
    }
    if (errors.length) say(errors.join(" "));
  } finally {
    stagingFiles.delete(key);
    renderPending();
  }
}

async function toggleEditing() {
  if (currentTurn?.notebookId === state.id) throw new Error("请等待当前回答完成后再编辑正文。");
  if (editing) {
    await change({
      type: "edit-document",
      title: get("title-input").value,
      blocks: Array.from(document.querySelectorAll(".block-editor"), (element) => ({
        id: element.dataset.blockId, text: element.value,
        removed: element.hidden,
        included: element.closest(".paper-block").querySelector(".include-block")?.checked
      }))
    });
  }
  editing = !editing;
  get("edit-label").textContent = editing ? "保存正文" : "编辑正文";
  actionButton("edit").setAttribute("aria-pressed", String(editing));
  renderDocument();
  renderPending();
  if (editing) {
    const editors = Array.from(document.querySelectorAll(".block-editor"));
    (editors.find((item) => item.dataset.blockId === activeBlock) || editors[0] || get("title-input")).focus();
  } else {
    say("正文已保存。");
  }
}

function redrawNotes() {
  renderDocument();
  renderChat();
}

async function handleAction(control) {
  const action = control.dataset.action;
  if (editing && ["ask", "branch", "note", "paste", "highlight", "underline", "locate-note",
    "locate-branch", "extract", "edit-note", "pin-note", "delete-note"].includes(action)) {
    throw new Error("请先点「保存正文」。");
  }
  const noteId = control.closest("[data-note-id]")?.dataset.noteId;
  const note = noteId && state.notes.find((item) => item.id === noteId);
  const turnId = control.closest("[data-turn-id]")?.dataset.turnId;
  switch (action) {
    case "toggle-library": {
      const sidebar = get("notebook-library");
      sidebar.hidden = !sidebar.hidden;
      control.setAttribute("aria-expanded", String(!sidebar.hidden));
      break;
    }
    case "new-notebook":
      if (editing) throw new Error("请先保存正在编辑的正文。");
      showEditor({
        heading: "新建笔记", text: "", limit: 160, rows: 2,
        save: (title) => switchNotebook(() => api.createNotebook(title))
      });
      break;
    case "open-notebook":
      if (control.dataset.notebookId === state.id) {
        activeView = "document";
        updateView();
      } else {
        await switchNotebook(() => api.openNotebook(control.dataset.notebookId));
      }
      break;
    case "remove-block": {
      const editor = control.closest(".paper-block").querySelector(".block-editor");
      editor.hidden = !editor.hidden;
      control.textContent = editor.hidden ? "撤销移除" : "移除段落";
      control.setAttribute("aria-pressed", String(editor.hidden));
      break;
    }
    case "choose-files":
      get(`${control.dataset.composer}-files`).click();
      break;
    case "open-attachment":
      await api.openAttachment(control.dataset.attachmentId);
      break;
    case "remove-attachment": {
      const key = draftKey(control.dataset.composer);
      await api.removeAttachment(control.dataset.attachmentId);
      draftFiles.set(key, (draftFiles.get(key) || []).filter((ref) => ref.id !== control.dataset.attachmentId));
      renderPending();
      break;
    }
    case "login": {
      const profile = currentProfile();
      if (!profile || logins.has(profile.id)) return;
      logins.add(profile.id);
      renderSettings();
      try {
        if (profile.provider === "claude") say("请在 Claude Code 打开的窗口中完成登录。");
        await api.login(profile.id);
        if (profile.provider === "gpt") say("请在浏览器中完成 ChatGPT 登录。");
      } finally {
        logins.delete(profile.id);
        renderSettings();
      }
      break;
    }
    case "add-account":
      showEditor({
        heading: `新增 ${providerName(settings.provider)} 账户`, reference: "为账户取个名字，例如「个人」或「工作」。",
        limit: 50, rows: 2,
        save: async (name) => {
          await changeSetting({ type: "add", name });
          say("账户配置已新增。点击顶部「登录」进行授权。");
        }
      });
      break;
    case "refresh":
      await refreshAccount();
      break;
    case "edit":
      await toggleEditing();
      break;
    case "paste":
      showEditor({
        heading: "插入文字",
        save: async (text) => {
          await change({ type: "add-blocks", text });
          activeBlock = state.blocks.at(-1).id;
          selectedText = null;
          renderDocument();
          get("main-form").scrollIntoView({ block: "nearest" });
        }
      });
      break;
    case "highlight":
    case "underline":
      await change({ type: "mark", style: action, anchor: anchor(true) });
      renderDocument();
      break;
    case "note": {
      const reference = anchor(true);
      showEditor({
        heading: "新建批注", reference: reference.quote,
        save: async (text) => {
          await change({ type: "add-note", anchor: reference, text });
          showNotes(true);
          redrawNotes();
          say("批注已保存。");
        }
      });
      break;
    }
    case "toggle-notes":
      showNotes(!notesVisible);
      break;
    case "locate-note":
      if (note) locate(note.anchor);
      break;
    case "edit-note":
      if (!note) return;
      showEditor({
        heading: "编辑批注", reference: note.anchor.quote, text: note.text,
        save: async (text) => {
          await change({ type: "edit-note", id: note.id, text });
          redrawNotes();
        }
      });
      break;
    case "pin-note":
    case "delete-note":
      if (!note) return;
      await change({ type: action, id: note.id });
      if (action === "delete-note") commentChats.forget(`note:${state.id}:${note.id}`);
      redrawNotes();
      break;
    case "ask":
    case "branch":
      await openFromSelection(action === "branch");
      break;
    case "open-branch":
      openChat(canvasSelection);
      break;
    case "document-from-canvas":
      activeView = "document";
      updateView();
      break;
    case "close-chat":
      chatOpen(false);
      actionButton("ask").focus();
      break;
    case "locate-branch":
      locate(currentBranch().anchor);
      break;
    case "delete-chat": {
      const id = currentBranchId;
      await change({ type: "delete-branch", id });
      sideDrafts.delete(id);
      await Promise.allSettled((draftFiles.get(id) || []).map((ref) => api.removeAttachment(ref.id)));
      draftFiles.delete(id);
      if (canvasSelection === id) canvasSelection = undefined;
      if (currentBranchId !== id) break;
      currentBranchId = undefined;
      selectedAnswer = null;
      get("side-turns").replaceChildren();
      get("side-question").value = "";
      chatOpen(false);
      actionButton("ask").focus();
      say("侧边对话已删除。");
      break;
    }
    case "extract":
      if (!selectedAnswer || selectedAnswer.turnId !== turnId) {
        throw new Error("请先在这条回答里选中要摘录的文字。");
      }
      await change({ type: "add-note", branchId: currentBranchId, turnId, text: selectedAnswer.text });
      window.getSelection()?.removeAllRanges();
      selectedAnswer = null;
      showNotes(true);
      renderDocument();
      say("摘录已保存到原文右侧。");
      break;
    case "edit-answer": {
      const branch = currentBranch();
      const turn = branch.turns.find((item) => item.id === turnId);
      showEditor({
        heading: "编辑回答", text: turn.answer,
        save: async (text) => {
          await change({ type: "edit-answer", id: branch.id, turnId, text });
          renderChat();
        }
      });
      break;
    }
    case "stop":
      if (currentTurn) {
        control.disabled = true;
        await api.stop(currentTurn.requestId);
      }
      break;
    case "cancel-editor":
      get("editor").close();
      break;
  }
}

document.addEventListener("selectionchange", captureSelection);
get("selection-tools").addEventListener("pointerdown", (event) => event.preventDefault());
window.addEventListener("scroll", () => { get("selection-tools").hidden = true; }, { capture: true, passive: true });
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) captureSelection();
});
get("blocks").addEventListener("pointerup", (event) => {
  const block = event.target.closest(".body-text");
  if (block && window.getSelection()?.isCollapsed) {
    activeBlock = block.dataset.blockId;
    selectedText = null;
  }
});
get("side-turns").addEventListener("pointerup", (event) => {
  if (event.target.closest(".answer-text") && window.getSelection()?.isCollapsed) selectedAnswer = null;
});
document.addEventListener("click", async (event) => {
  const link = event.target.closest("[data-markdown-link]");
  if (link) {
    event.preventDefault();
    api.openLink(link.dataset.markdownLink).catch((error) => say(error.message));
    return;
  }
  const control = event.target.closest("button");
  if (!control || !state) return;
  get("selection-tools").hidden = true;
  if (control.dataset.view) {
    if (editing && control.dataset.view !== "document") {
      say("请先保存正文。");
      return;
    }
    activeView = control.dataset.view;
    updateView();
  }
  try {
    await handleAction(control);
  } catch (error) {
    say(error.message);
  }
});
get("side-question").addEventListener("input", (event) => {
  if (currentBranchId) sideDrafts.set(currentBranchId, event.target.value);
});
get("memory-list").addEventListener("change", async (event) => {
  try {
    await change({
      type: "memory", id: currentBranchId, noteId: event.target.dataset.memory, enabled: event.target.checked
    });
  } catch (error) {
    say(error.message);
  }
  renderChat();
});
get("main-memory-list").addEventListener("change", async (event) => {
  try {
    await change({ type: "main-memory", noteId: event.target.dataset.memory, enabled: event.target.checked });
  } catch (error) {
    say(error.message);
  }
  renderMainContext();
});
get("editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await editorSave(get("editor-text").value);
    get("editor").close();
  } catch (error) {
    say(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
for (const kind of ["main", "side"]) {
  const form = get(`${kind}-form`);
  const input = get(`${kind}-files`);
  const add = (selected) => stageFiles(kind, selected).catch((error) => say(error.message));
  input.addEventListener("change", () => {
    const selected = Array.from(input.files);
    input.value = "";
    add(selected);
  });
  form.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    form.classList.add("dragging");
  });
  form.addEventListener("dragleave", (event) => {
    if (!form.contains(event.relatedTarget)) form.classList.remove("dragging");
  });
  form.addEventListener("drop", (event) => {
    form.classList.remove("dragging");
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    add(Array.from(event.dataTransfer.files));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendQuestion(kind).catch((error) => say(error.message));
  });
}
window.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files.length) event.preventDefault();
});

api.onProgress(({ requestId, text }) => {
  if (currentTurn?.requestId !== requestId) return;
  currentTurn.text = text;
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    const output = document.querySelector(".pending:not([hidden]) .pending-output");
    if (output && currentTurn) renderMarkdown(output, currentTurn.text);
  });
});
api.onAccount(({ id, success }) => {
  if (id !== currentProfile()?.id) return;
  if (success) void refreshAccount();
  else say("登录未完成，请重试。");
});
for (const [id, type, field] of [
  ["provider-picker", "provider", "provider"],
  ["account-picker", "select", "id"],
  ["model-picker", "model", "model"],
  ["effort-picker", "effort", "effort"]
]) {
  get(id).addEventListener("change", (event) => {
    changeSetting({ type, [field]: event.target.value }).catch((error) => say(error.message));
  });
}
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--ribbon-height", `${entry.target.offsetHeight}px`);
}).observe(document.querySelector(".app-header"));
const commentChats = setupCommentChats(api, {
  profile: currentProfile, notify: say, openFork: (target) => switchNotebook(() => api.forkComment(target))
});
const pdfReview = setupPdfReview(api, { edit: showEditor, notify: say, commentChats });

try {
  const [notebook, savedSettings, library] = await Promise.all([api.read(), api.settings(), api.library()]);
  accept(notebook);
  settings = savedSettings;
  libraryItems = library.items;
  activeBlock = state.blocks[0]?.id;
  renderDocument();
  updateView();
  renderPending();
  await refreshAccount();
} catch (error) {
  say(error.message);
}
