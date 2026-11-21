import { contextBlockIds, findAnchor, mainHistory, messageGroups, sharedNoteBlocks, sharedNoteIncluded } from "./notebook.mjs";
import { renderMarkdown, selectionSource, sourceRange } from "./markdown-dom.mjs";
import { setupPdfReview } from "./pdf-review-ui.mjs";
import { setupCommentChats } from "./comment-chat.mjs";
import { avatarChoices, pixelAvatar } from "./pixel-avatars.mjs";

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
const iconPaths = {
  fold: "M6 9l6 6 6-6", edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  note: "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6",
  margin: "M4 5h16v11H10l-5 4v-4H4z M8 9h8 M8 12h5",
  pin: "M8 3h8l-1 5 3 3v2H6v-2l3-3z M12 13v8"
};
const iconButton = (icon, action, label) => {
  const control = button("", action, "message-icon");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPaths[icon]);
  svg.append(path);
  control.append(svg);
  control.title = label;
  control.setAttribute("aria-label", label);
  return control;
};

let state;
let libraryItems = [];
let libraryFolders = [];
const collapsedFolders = new Set();
let libraryBusy = false;
let activeView = "document";
let focusMode = null;
let focusedNoteId = null;
let activeBlock;
let selectedText = null;
let selectedAnswer = null;
let currentBranchId;
let canvasSelection;
let notesVisible = true;
let editingMessage = null;
let editingNote = null;
const collapsedNotes = new Set();
let currentTurn;
let pendingFrame = false;
let selectingMessages = false;
// The multi-select was opened from 主对话上下文 to pick context, not to start a new chat.
let choosingContext = false;
let activeMessage;
let imageInsertAfter;
const selectedMessages = new Set();
const selectedNotes = new Set();
const renderedMessages = new Set();
const collapsedMessages = new Set();
let settings;
let account = {};
const accountCache = new Map();
const limitCache = new Map();
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
// This chat's members: its own roster once set up, else the app's default roster.
const roster = () => state?.members?.length ? { members: state.members, defaultMember: state.defaultMember }
  : { members: settings?.members || [], defaultMember: settings?.defaultMember };
const members = () => roster().members;
const memberById = (id) => members().find((item) => item.id === id) ?? settings?.members?.find((item) => item.id === id);
const defaultMember = () => members().find((item) => item.id === roster().defaultMember) ?? members()[0];
const profileOf = (member) => settings?.profiles.find((item) => item.id === member?.profileId);
// The account check, login button and model pickers follow the default member's account.
const currentProfile = () => profileOf(defaultMember());
const providerName = (provider) => ({ claude: "Claude", gemini: "Gemini" })[provider] || "GPT";
const sourceLabel = (source) => [providerName(source?.provider), source?.model, source?.effort].filter(Boolean).join(" · ");
const appearanceDefaults = { background: "garden", userAvatar: "human", gptAvatar: "robot", claudeAvatar: "fox" };
const appearance = () => ({ ...appearanceDefaults, ...settings?.appearance });
const avatarFor = (provider) => appearance()[provider === "claude" ? "claudeAvatar" : "gptAvatar"];
// Who said it: the member as they are now (renames and new avatars apply to old replies too),
// else what was saved with the reply, else the provider.
const speakerName = (source) => memberById(source?.memberId)?.name ?? source?.memberName ?? providerName(source?.provider);
const speakerAvatar = (source) => memberById(source?.memberId)?.avatar ?? source?.avatar ?? avatarFor(source?.provider);
const mentionPattern = /@([\p{L}\p{N}_-]{1,24})/gu;

// Members named with @ in a question, in the order they appear.
function mentionedMembers(text) {
  const found = [];
  const unknown = [];
  for (const [, name] of text.matchAll(mentionPattern)) {
    const member = members().find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (member && !found.includes(member)) found.push(member);
    else if (!member && !unknown.includes(name)) unknown.push(name);
  }
  return { found, unknown };
}
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
  const list = get("notebook-list");
  const fragments = document.createDocumentFragment();
  const menu = (label, entries) => {
    const details = node("details", "library-menu");
    const trigger = node("summary", "", "⋯");
    trigger.title = `${label}的操作`;
    trigger.setAttribute("aria-label", `${label}的操作`);
    const actions = node("div", "library-menu-actions");
    actions.append(...entries);
    details.append(trigger, actions);
    return details;
  };
  const itemRow = (item) => {
    const selected = item.id === state?.id;
    const title = selected ? state.title : item.title;
    const row = node("div", "library-item-row");
    const control = button(title, "open-notebook", "notebook-item");
    control.dataset.notebookId = item.id;
    control.title = title;
    if (selected) control.setAttribute("aria-current", "page");
    const actions = [button("在新窗口打开", "open-notebook-window"), button("重命名", "rename-notebook"), button("移到主题…", "move-notebook"),
      button("删除会话", "delete-notebook", "danger")];
    for (const action of actions) action.dataset.notebookId = item.id;
    row.append(control, menu(title, actions));
    return row;
  };
  for (const folder of libraryFolders) {
    const section = node("section", "library-folder");
    const header = node("div", "library-folder-header");
    const toggle = button(`${collapsedFolders.has(folder.id) ? "▸" : "▾"} ${folder.name}`, "toggle-folder", "library-folder-toggle");
    toggle.dataset.folderId = folder.id;
    toggle.setAttribute("aria-expanded", String(!collapsedFolders.has(folder.id)));
    const actions = [button("重命名主题", "rename-folder"), button("在此新建会话", "new-notebook-in-folder"),
      button("删除主题", "delete-folder", "danger")];
    for (const action of actions) action.dataset.folderId = folder.id;
    header.append(toggle, menu(folder.name, actions));
    section.append(header);
    if (!collapsedFolders.has(folder.id)) {
      const items = node("div", "library-folder-items");
      items.append(...libraryItems.filter((item) => item.folderId === folder.id).map(itemRow));
      section.append(items);
    }
    fragments.append(section);
  }
  const uncategorized = libraryItems.filter((item) => !item.folderId || !libraryFolders.some((folder) => folder.id === item.folderId));
  if (uncategorized.length) {
    const section = node("section", "library-folder");
    section.append(node("div", "library-ungrouped-title", "未分类"));
    const items = node("div", "library-folder-items");
    items.append(...uncategorized.map(itemRow));
    section.append(items);
    fragments.append(section);
  }
  list.replaceChildren(fragments);
}

async function switchNotebook(open) {
  if (editingMessage || editingNote) throw new Error("请先保存或取消当前编辑。");
  if (libraryBusy) return;
  libraryBusy = true;
  try {
    const result = await open();
    if (state) mainDrafts.set(state.id, get("main-question").value);
    const oldProfileId = currentProfile()?.id;
    state = result.state;
    setFocus(null);
    libraryItems = result.items;
    libraryFolders = result.folders || [];
    activeBlock = state.blocks.find((item) => !item.removed)?.id;
    selectedText = selectedAnswer = currentBranchId = canvasSelection = undefined;
    selectingMessages = false;
    stopAnnotationPick();
    activeMessage = undefined;
    selectedMessages.clear();
    renderSelectionBar();
    get("main-question").value = mainDrafts.get(state.id) || "";
    chatOpen(false);
    activeView = "document";
    renderDocument();
    updateView();
    renderPending();
    // Each chat has its own default member, possibly on another account.
    if (currentProfile()?.id !== oldProfileId) void refreshAccount();
    else renderSettings();
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
    if (rect?.height && rect.bottom > headerBottom && rect.top < innerHeight && !editingMessage) {
      tools.hidden = false;
      get("pick-here").hidden = !annotationPick;
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
  if (editingMessage) throw new Error("请先保存或取消当前编辑。");
  const element = Array.from(get("document-view").querySelectorAll(".body-text"))
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

// ---- Moving a message into the margin: the user picks where the annotation hangs -------------

let annotationPick = null;

function startAnnotationPick(messageId, ids) {
  annotationPick = { messageId, ids };
  window.getSelection()?.removeAllRanges();
  document.body.classList.add("picking-annotation");
  for (const row of messageRows()) row.classList.toggle("pick-source", row.dataset.messageId === messageId);
  get("annotation-pick-bar").hidden = false;
  say("选一个位置挂这条批注：选中任意消息里的一段文字后点「挂在这里」，或直接点一条消息。");
}

function stopAnnotationPick() {
  annotationPick = null;
  document.body.classList.remove("picking-annotation");
  for (const row of document.querySelectorAll(".pick-source")) row.classList.remove("pick-source");
  get("annotation-pick-bar").hidden = true;
  get("pick-here").hidden = true;
}

// The start of a message's first line, for hanging an annotation on the message as a whole.
function messageAnchor(messageId) {
  if (messageId === annotationPick?.messageId) {
    say("批注不能挂在它自己这条消息上，请选别的消息。");
    return null;
  }
  const group = messageGroups(state.blocks).find((item) => item.blocks[0].id === messageId);
  const block = group?.blocks.find((item) => !item.removed && item.text.trim());
  if (!block) {
    say("这条消息没有文字，换一条或先选中一段文字。");
    return null;
  }
  const start = block.text.search(/\S/);
  return { blockId: block.id, start, quote: block.text.slice(start).split(/\r?\n/, 1)[0].slice(0, 40) };
}

async function finishAnnotationPick(target) {
  const { ids } = annotationPick;
  if (target && ids.includes(target.blockId)) throw new Error("批注不能挂在它自己这条消息上，请选别的消息。");
  await change({ type: "message-to-annotation", ids, ...(target ? { anchor: target } : {}) });
  stopAnnotationPick();
  window.getSelection()?.removeAllRanges();
  get("selection-tools").hidden = true;
  showNotes(true);
  renderDocument();
  say("已移到页边批注。需要时可在「主对话上下文」里把它选入上下文。");
}

function annotation(note) {
  const card = node("article", "annotation");
  card.dataset.noteId = note.id;
  card.classList.toggle("is-focused", focusMode === "note" && focusedNoteId === note.id);
  const editingThis = editingNote?.id === note.id;
  const collapsed = collapsedNotes.has(note.id) && !editingThis;
  card.classList.toggle("is-collapsed", collapsed);
  card.classList.toggle("editing-inline", editingThis);
  const label = anchorLabel(note.anchor);
  const quote = button(label, "locate-note", "quote-button");
  quote.setAttribute("aria-label", `定位原文：${label}`);
  const pin = iconButton("pin", "pin-note", note.pinned ? "取消固定记忆" : "固定为记忆");
  pin.setAttribute("aria-pressed", String(note.pinned));
  const commands = node("div", "annotation-actions");
  const collapse = iconButton("fold", "toggle-note", collapsed ? "展开批注" : "收起批注");
  collapse.setAttribute("aria-expanded", String(!collapsed));
  const edit = iconButton("edit", "edit-note", "编辑批注");
  const remove = iconButton("trash", "delete-note", "删除批注");
  const expand = button("↗", "focus-note", "note-expand");
  expand.title = "放大批注和追问";
  expand.setAttribute("aria-label", "放大批注和追问");
  commands.append(expand, collapse, edit, remove, pin);
  const content = node("div", "markdown-content note-content");
  renderMarkdown(content, note.text);
  const head = node("div", "annotation-head");
  head.append(node("strong", "author", note.author), commands);
  // Annotations stay out of the main chat unless chosen in 主对话上下文.
  if (choosingContext) {
    const check = node("input", "note-select");
    check.type = "checkbox";
    check.dataset.noteId = note.id;
    check.checked = selectedNotes.has(note.id);
    check.setAttribute("aria-label", "把这条批注放进主对话上下文");
    card.classList.toggle("selected", check.checked);
    head.prepend(check);
  } else if ((state.context?.notes || []).includes(note.id)) {
    head.append(node("span", "in-context", "在上下文中"));
  }
  card.append(head);
  if (collapsed) {
    card.append(node("p", "annotation-preview", note.text.replace(/\s+/g, " ").slice(0, 80)));
  } else if (editingThis) {
    const tabs = node("div", "inline-editor-tabs");
    const editTab = button("编辑", "note-edit-tab");
    const previewTab = button("预览", "note-preview-tab");
    editTab.setAttribute("aria-pressed", String(!editingNote.preview));
    previewTab.setAttribute("aria-pressed", String(editingNote.preview));
    tabs.append(editTab, previewTab);
    card.append(tabs);
    if (editingNote.preview) {
      const preview = node("div", "markdown-content note-content");
      renderMarkdown(preview, editingNote.text || "*空批注*");
      card.append(preview);
    } else {
      const input = node("textarea", "note-inline-text");
      input.value = editingNote.text;
      input.rows = 6;
      input.maxLength = 60000;
      input.setAttribute("aria-label", "编辑批注内容");
      card.append(input);
    }
    const actions = node("div", "note-inline-actions");
    actions.append(button("取消", "cancel-note-edit"), button("保存", "save-note-edit", "primary"));
    card.append(actions);
  } else {
    card.append(quote, content);
    if (note.attachments?.length) card.append(sentAttachments(note.attachments));
  }
  const notebookId = state.id;
  commentChats.mount(card, {
    key: `note:${notebookId}:${note.id}`,
    target: () => ({ notebookId, noteId: note.id }),
    turns: () => (state.id === notebookId ? state.notes.find((item) => item.id === note.id)?.turns : note.turns) || [],
    receive: ({ notebook }) => accept(notebook)
  });
  if (editingThis) card.querySelector(".comment-thread")?.setAttribute("hidden", "");
  return card;
}

const isImageRef = (ref) => [".png", ".jpg", ".jpeg", ".webp"].includes(ref.extension);
const storedAttachment = (id) => [
  ...state.blocks.flatMap((block) => block.attachments || []),
  ...state.notes.flatMap((note) => note.attachments || []),
  ...state.branches.flatMap((branch) => branch.turns.flatMap((turn) => turn.attachments || [])),
  ...[...draftFiles.values()].flat()
].find((ref) => ref.id === id);

// Images show as a picture (click to open full size); other files as a name.
function attachmentChip(ref, kind) {
  const image = isImageRef(ref);
  if (!kind) {
    const link = button("", "open-attachment", image ? "attachment-thumb" : "attachment-chip");
    link.dataset.attachmentId = ref.id;
    link.title = image ? `${ref.name}（点击查看原图）` : ref.name;
    if (image) {
      const picture = node("img");
      picture.src = `notebook://app/note-image/${ref.id}`;
      picture.alt = ref.name;
      link.append(picture);
    } else {
      link.append(node("span", "", ref.name));
    }
    return link;
  }
  const chip = node("span", image ? "attachment-chip has-thumb" : "attachment-chip");
  if (image) {
    const picture = node("img", "draft-thumb");
    picture.src = `notebook://app/note-image/${ref.id}`;
    picture.alt = "";
    chip.append(picture);
  }
  const name = node("span", "", ref.name);
  name.title = ref.name;
  if (ref.extension === ".pdf") {
    const preview = button("审阅", "open-attachment", "preview-file");
    preview.dataset.attachmentId = ref.id;
    preview.setAttribute("aria-label", `审阅 PDF：${ref.name}`);
    chip.append(preview);
  }
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

const folderName = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;

function renderWorkDir() {
  const folder = state.workDir;
  get("work-dir").classList.toggle("is-set", Boolean(folder));
  get("work-dir-label").textContent = folder ? `📁 ${folderName(folder)}` : "📁 工作文件夹：默认";
  get("work-dir-label").title = folder
    ? `模型在这个文件夹里读写文件：\n${folder}\n点击可更换（侧边对话和批注追问也用它）`
    : "选择这个聊天里模型读写文件的文件夹，类似 Codex / Claude Code 的项目目录";
  get("clear-work-dir").hidden = !folder;
}

const formatSize = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const backupKinds = { auto: "自动", manual: "手动", "before-restore": "恢复前", "before-move": "迁移前" };

function renderDataInfo(info) {
  get("data-path").textContent = info.dataDir;
  get("data-stats").textContent = `${info.notebooks} 本笔记 · 数据库 ${formatSize(info.databaseSize)} · ` +
    `附件 ${info.attachments.count} 个（${formatSize(info.attachments.size)}）` +
    (info.trash.count ? ` · 已移除附件保留 ${info.trash.count} 个` : "") +
    (info.source === "env" ? " · 由环境变量 AI_NOTEBOOK_DATA_DIR 指定" : "");
  get("data-move").disabled = info.source === "env";
  get("data-backup-note").textContent = `每次启动、关闭和运行中每 6 小时，只要笔记有改动就自动备份一次，保留最近 ${info.autoBackupsKept} 份；` +
    "手动、恢复前和迁移前的备份不会自动删除。被删除消息里的附件会移到 attachments-trash，恢复旧备份时自动找回。";
  const rows = info.backups.map((item) => {
    const row = node("div", "backup-row");
    const restore = button("恢复", "data-restore");
    restore.dataset.backup = item.name;
    row.append(node("span", "", new Date(item.created).toLocaleString()), node("span", "backup-kind", backupKinds[item.kind] || item.kind),
      node("span", "backup-kind", formatSize(item.size)), restore);
    return row;
  });
  get("backup-list").replaceChildren(...(rows.length ? rows : [node("p", "backup-empty", "还没有备份。")]));
}

async function openDataDialog() {
  renderDataInfo(await api.dataInfo());
  if (!get("data-dialog").open) get("data-dialog").showModal();
}

// ---- Group chat: @ mentions in the question box --------------------------------------------

// Chips under the question box: click one to @ that member. The hint says who will answer.
function renderMentionBar() {
  const bar = get("mention-bar");
  const fallback = defaultMember();
  if (!bar || !fallback) return;
  const chips = members().map((member) => {
    const chip = button("", "mention", "mention-chip");
    chip.dataset.memberName = member.name;
    chip.title = `@${member.name} · ${sourceLabel({ provider: profileOf(member)?.provider, model: member.model, effort: member.effort })}`;
    chip.append(pixelAvatar(member.avatar, "idle", ""), node("span", "", member.name));
    if (member.id === fallback.id) chip.classList.add("is-default");
    return chip;
  });
  const manage = button("成员…", "open-members", "mention-manage");
  bar.replaceChildren(node("span", "mention-label", "@"), ...chips, manage);
  renderMentionHint();
}

function renderMentionHint() {
  const hint = get("mention-hint");
  const fallback = defaultMember();
  if (!hint || !fallback) return;
  // A mention still being typed at the end is not flagged as unknown yet.
  const text = get("main-question").value.replace(/@[\p{L}\p{N}_-]*$/u, "");
  const { found } = mentionedMembers(get("main-question").value);
  const { unknown } = mentionedMembers(text);
  hint.textContent = (found.length > 1 ? `将由 ${found.map((item) => item.name).join(" → ")} 依次回答，后面的人能看到前面的回答`
    : found.length ? `将由 ${found[0].name} 回答` : `没有 @ 时由默认成员 ${fallback.name} 回答`) +
    (unknown.length ? ` · ${unknown.map((name) => `@${name}`).join("、")} 不是成员` : "");
}

let mentionMenu = null;

// The "@abc" being typed right before the caret, if any.
function mentionQuery(input) {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|[^\w@])@([\p{L}\p{N}_-]*)$/u.exec(before);
  return match ? { start: before.length - match[2].length - 1, text: match[2] } : null;
}

function closeMentionMenu() {
  mentionMenu = null;
  get("mention-menu").hidden = true;
}

function updateMentionMenu(input) {
  const query = mentionQuery(input);
  const options = query ? members().filter((item) => item.name.toLowerCase().startsWith(query.text.toLowerCase())) : [];
  if (!query || !options.length) return closeMentionMenu();
  mentionMenu = { input, query, options, index: Math.min(mentionMenu?.index ?? 0, options.length - 1) };
  const menu = get("mention-menu");
  menu.replaceChildren(...options.map((member, index) => {
    const item = button("", "", "mention-option");
    item.dataset.memberName = member.name;
    item.setAttribute("aria-selected", String(index === mentionMenu.index));
    item.append(pixelAvatar(member.avatar, "idle", ""), node("strong", "", member.name),
      node("span", "", sourceLabel({ provider: profileOf(member)?.provider, model: member.model })));
    item.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      insertMention(member.name, input);
    });
    return item;
  }));
  const form = input.closest("form");
  menu.style.left = `${input.offsetLeft}px`;
  menu.style.bottom = `${form.offsetHeight - input.offsetTop + 4}px`;
  form.append(menu);
  menu.hidden = false;
}

function insertMention(name, input = get("main-question")) {
  const query = mentionMenu?.input === input ? mentionQuery(input) : null;
  const start = query ? query.start : input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const spacer = before && !/\s$/.test(before) ? " " : "";
  input.value = `${before}${spacer}@${name} ${input.value.slice(end).replace(/^\s+/, "")}`;
  const caret = before.length + spacer.length + name.length + 2;
  input.focus();
  input.setSelectionRange(caret, caret);
  closeMentionMenu();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

for (const id of ["main-question", "side-question"]) {
  const input = get(id);
  input.addEventListener("input", () => {
    updateMentionMenu(input);
    if (id === "main-question") renderMentionHint();
  });
  input.addEventListener("blur", () => setTimeout(closeMentionMenu, 120));
  input.addEventListener("keydown", (event) => {
    if (!mentionMenu || mentionMenu.input !== input || event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      mentionMenu.index = (mentionMenu.index + step + mentionMenu.options.length) % mentionMenu.options.length;
      updateMentionMenu(input);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(mentionMenu.options[mentionMenu.index].name, input);
    } else if (event.key === "Escape") {
      closeMentionMenu();
    }
  });
}

// ---- Group chat: member management page ---------------------------------------------------

const tokenCount = (value = 0) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const limitStatus = { allowed: "正常", allowed_warning: "接近上限", rejected: "已达上限" };

async function checkAccount(id) {
  accountCache.set(id, { message: "正在检查" });
  try {
    accountCache.set(id, await api.account(id));
  } catch (error) {
    accountCache.set(id, { message: error.message.slice(0, 80) });
  }
}

async function loadLimits(id, announce = false) {
  try {
    limitCache.set(id, await api.accountLimits(id));
  } catch (error) {
    limitCache.set(id, { items: [], note: `额度读取失败：${error.message.slice(0, 80)}` });
  }
  refreshPanels();
  if (announce) say("额度已刷新。");
}

const openPrompts = new Set();
const rolePresets = {
  "严格审稿人": "你是一位严格的审稿人。只指出论证中的漏洞、缺失的证据和可能的反例，按严重程度排序；不做客套，不总结对方观点。",
  "反方辩手": "你是反方辩手。无论前面的结论是什么，都要找出最有力的反对理由和替代解释，并说明在什么条件下反方成立。",
  "总结整理": "你负责整理。把前面各位成员的观点归纳成要点清单，标出共识、分歧和尚未回答的问题，不加入新观点。",
  "耐心导师": "你是一位耐心的导师。用直观例子一步步解释，先讲直觉再讲细节，最后给一个小练习检验理解。"
};

// Member edits apply to this chat; the first one copies the app's default roster into the chat.
async function changeMembers(action) {
  const notebookId = state.id;
  const oldProfileId = currentProfile()?.id;
  const { state: next, result } = await api.changeMembers(notebookId, action);
  if (state.id === notebookId) accept(next);
  if (currentProfile()?.id !== oldProfileId) void refreshAccount();
  else renderSettings();
  renderDocument();
  renderPending();
  refreshPanels();
  return result;
}

async function openMembers() {
  settings = await api.settings();
  renderSettings();
  if (!get("members-dialog").open) get("members-dialog").showModal();
  renderMembers();
  const used = new Set(members().map((item) => item.profileId));
  await Promise.all(settings.profiles.filter((profile) => used.has(profile.id)).map(async (profile) => {
    if (!accountCache.get(profile.id)?.models) await checkAccount(profile.id);
    refreshPanels();
  }));
}

function memberCard(member) {
  const profile = profileOf(member);
  const card = node("article", "member-card");
  card.dataset.memberId = member.id;
  const face = button("", "member-avatar", "member-face");
  face.dataset.memberId = member.id;
  face.title = "点击换头像";
  face.append(pixelAvatar(member.avatar, "idle", `${member.name} 的头像`));
  const name = node("input", "member-name");
  name.value = member.name;
  name.maxLength = 24;
  name.dataset.memberId = member.id;
  name.setAttribute("aria-label", "成员名（@ 时使用）");
  const accountPicker = node("select", "member-account");
  accountPicker.dataset.memberId = member.id;
  accountPicker.setAttribute("aria-label", "使用的账户");
  accountPicker.replaceChildren(...settings.profiles.map((item) => option(item.id, `${providerName(item.provider)} · ${item.name}`)));
  accountPicker.value = member.profileId;
  const model = node("select", "member-model");
  const effort = node("select", "member-effort");
  model.dataset.memberId = effort.dataset.memberId = member.id;
  model.setAttribute("aria-label", "模型");
  effort.setAttribute("aria-label", "Effort");
  fillModelPickers(model, effort, profile?.provider, accountCache.get(member.profileId)?.models || [],
    member.model || "", member.effort || "");
  const isDefault = member.id === roster().defaultMember;
  const makeDefault = button(isDefault ? "默认回答" : "设为默认", "member-default", isDefault ? "is-default" : "");
  makeDefault.dataset.memberId = member.id;
  makeDefault.disabled = isDefault;
  const promptToggle = button(member.prompt ? "角色设定 ✓" : "角色设定", "member-prompt-toggle",
    member.prompt ? "has-prompt" : "");
  promptToggle.dataset.memberId = member.id;
  promptToggle.setAttribute("aria-expanded", String(openPrompts.has(member.id)));
  promptToggle.title = member.prompt ? member.prompt.slice(0, 300) : "给这位成员写一段系统提示，让它扮演特定身份";
  const clone = button("＋ 新身份", "member-clone");
  clone.dataset.memberId = member.id;
  clone.title = "用同一个账户和模型再建一位成员，再给它另写角色设定";
  const remove = button("移除", "member-remove", "danger");
  remove.dataset.memberId = member.id;
  const usage = settings.usage?.[member.id];
  const today = usage?.day === new Date().toISOString().slice(0, 10);
  const usageText = usage ? `今天 ${today ? usage.dayTurns : 0} 次 · 共 ${usage.turns} 次 · ` +
    `输入 ${tokenCount(usage.inputTokens)} / 输出 ${tokenCount(usage.outputTokens)} tokens` : "还没有回答过";
  const fields = node("div", "member-fields");
  fields.append(name, accountPicker, model, effort);
  const footer = node("div", "member-footer");
  footer.append(node("span", "member-usage", usageText), promptToggle, clone, makeDefault, remove);
  card.append(face, fields, footer);
  if (openPrompts.has(member.id)) {
    const area = node("div", "member-prompt-area");
    const box = node("textarea", "member-prompt");
    box.dataset.memberId = member.id;
    box.rows = 4;
    box.maxLength = 4000;
    box.value = member.prompt || "";
    box.placeholder = "例如：你是一位严格的审稿人，只指出论证漏洞和需要补的证据，不做总结。（离开输入框时保存）";
    box.setAttribute("aria-label", `${member.name} 的角色设定`);
    const presets = node("div", "member-presets");
    presets.append(node("span", "member-usage", "常用身份："), ...Object.keys(rolePresets).map((key) => {
      const preset = button(key, "member-prompt-preset");
      preset.dataset.preset = key;
      return preset;
    }));
    area.append(box, presets);
    card.append(area);
  }
  return card;
}

function limitRows(id) {
  const limits = limitCache.get(id);
  if (!limits) return [node("p", "member-usage", "额度：读取中…")];
  const rows = (limits.items || []).map((item) => {
    const row = node("div", "limit-row");
    const used = Number.isFinite(item.usedPercent) ? Math.max(0, Math.min(100, item.usedPercent)) : null;
    const bar = node("span", "limit-bar");
    const fill = node("span", "limit-fill");
    fill.style.width = `${used ?? 0}%`;
    fill.classList.toggle("is-high", (used ?? 0) >= 80 || item.status === "rejected");
    bar.append(fill);
    const reset = item.resetsAt ? `${new Date(item.resetsAt).toLocaleString([], { month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit" })} 重置` : "";
    const text = [used !== null ? `已用 ${Math.round(used)}% · 剩余 ${Math.round(100 - used)}%` : limitStatus[item.status] || item.status,
      reset].filter(Boolean).join(" · ");
    row.append(node("strong", "", item.label), bar, node("span", "", text));
    return row;
  });
  if (limits.report) {
    const report = node("pre", "limit-report", limits.report);
    rows.push(report);
  }
  const note = limits.note || (!limits.live && limits.updated ? `上次回答时看到的状态（${new Date(limits.updated).toLocaleString()}）` : "");
  if (note) rows.push(node("p", "member-usage", note));
  if (!rows.length) rows.push(node("p", "member-usage", "这个账户没有返回额度信息。"));
  return rows;
}

function accountCard(profile) {
  const status = accountCache.get(profile.id);
  const card = node("article", "account-card");
  const users = members().filter((item) => item.profileId === profile.id).map((item) => item.name);
  const head = node("div", "account-head");
  head.append(node("span", `provider-badge is-${profile.provider}`, providerName(profile.provider)),
    node("strong", "", profile.name),
    node("span", "member-usage", status?.message || (status?.signedIn
      ? [status.plan?.toUpperCase(), status.email].filter(Boolean).join(" · ") || "已登录" : status ? "未登录" : "")));
  const login = button(logins.has(profile.id) ? "登录中" : status?.signedIn ? "重新登录" : "登录", "login");
  login.dataset.profileId = profile.id;
  login.disabled = logins.has(profile.id);
  const refresh = button("刷新额度", "account-limits");
  refresh.dataset.profileId = profile.id;
  refresh.disabled = !status?.signedIn;
  head.append(login, refresh);
  if (!profile.native) {
    const remove = button("删除", "account-remove", "danger");
    remove.dataset.profileId = profile.id;
    head.append(remove);
  }
  const usage = settings.accountUsage?.[profile.id];
  const today = usage?.day === new Date().toISOString().slice(0, 10);
  card.append(head, node("p", "member-usage", [
    usage ? `本应用里：今天 ${today ? usage.dayTurns : 0} 次 · 共 ${usage.turns} 次 · 输入 ${tokenCount(usage.inputTokens)} / 输出 ${tokenCount(usage.outputTokens)} tokens`
      : "本应用里还没有用这个账户回答过",
    users.length ? `当前聊天的成员：${users.join("、")}` : ""].filter(Boolean).join(" · ")));
  if (status?.signedIn) card.append(...limitRows(profile.id));
  return card;
}

// Whichever of the members dialog and the apps page is showing.
function refreshPanels() {
  if (get("members-dialog").open) renderMembers();
  if (activeView === "apps") renderApps();
}

function renderMembers() {
  get("member-list").replaceChildren(...members().map(memberCard));
  get("members-scope").textContent = state.members?.length
    ? `这些成员只属于「${state.title}」。` : "这个聊天还在用默认成员；改动后会成为这个聊天自己的成员表。";
}

// ---- Apps & accounts page (sidebar) -------------------------------------------------------

let appsInfo = null;

async function openApps(force = false) {
  settings = await api.settings();
  renderApps();
  if (!appsInfo || force) {
    appsInfo = await api.apps();
    renderApps();
  }
  await Promise.all(settings.profiles.map(async (profile) => {
    if (force || !accountCache.get(profile.id)?.models) await checkAccount(profile.id);
    if (activeView === "apps") renderApps();
    if (accountCache.get(profile.id)?.signedIn && (force || !limitCache.has(profile.id))) await loadLimits(profile.id);
  }));
}

function renderApps() {
  const apps = appsInfo || ["gpt", "claude", "gemini"].map((provider) => ({ provider, title: providerName(provider), checking: true }));
  get("apps-list").replaceChildren(...apps.map((app) => {
    const section = node("section", `app-card is-${app.provider}`);
    const head = node("div", "app-head");
    head.append(node("span", `provider-badge is-${app.provider}`, app.title), node("strong", "", app.cli || ""),
      node("span", "member-usage", app.checking ? "正在检查…" : app.found ? `已安装 ${app.version || ""}`.trim() : app.error || "未安装"));
    if (app.path) head.title = app.path;
    const add = button(`＋ ${app.title} 账户`, "account-add");
    add.dataset.provider = app.provider;
    add.disabled = app.multiAccount === false;
    if (app.multiAccount === false) add.title = "这个应用只能用本机一个登录";
    head.append(add);
    section.append(head);
    if (app.note) section.append(node("p", "app-note", app.note));
    const accounts = settings.profiles.filter((profile) => profile.provider === app.provider);
    if (accounts.length) section.append(...accounts.map(accountCard));
    else section.append(node("p", "member-usage", "还没有账户。"));
    return section;
  }));
}

get("members-dialog").addEventListener("change", (event) => {
  const id = event.target.dataset.memberId;
  if (!id) return;
  const field = { "member-name": "name", "member-account": "profileId", "member-model": "model", "member-effort": "effort",
    "member-prompt": "prompt" }[event.target.className];
  if (!field) return;
  changeMembers({ type: "member-update", id, [field]: event.target.value }).then(async () => {
    if (field === "prompt") say("角色设定已保存。");
    if (field === "profileId" && !accountCache.get(event.target.value)?.models) {
      await checkAccount(event.target.value);
      renderMembers();
    }
  }).catch((error) => {
    say(error.message);
    renderMembers();
  });
});

function renderMainContext() {
  const history = mainHistory(state);
  const memoryIds = state.mainMemoryIds || [];
  const picked = Array.isArray(state.context?.ids) ? state.context.ids.length : null;
  const notes = state.context?.notes?.length || 0;
  const chosen = Boolean(state.context);
  get("main-context-count").textContent = `${picked !== null ? "已选消息 · " : ""}${history.length} 轮 · ${sharedNoteBlocks(state).length} 个笔记块${notes ? ` · ${notes} 条批注` : ""} · ${memoryIds.length} 条记忆`;
  get("main-context").classList.toggle("is-chosen", chosen);
  const scope = get("context-scope");
  const pick = button(chosen ? "重新选择…" : "选择消息和批注作为上下文…", "choose-context");
  const messages = picked === null ? "之前的全部消息" : picked === 0 ? "不带之前的消息，只带选择之后的新消息（变灰的不会发给模型）"
    : `选中的 ${picked} 条消息加上选择之后的新消息（变灰的不会发给模型）`;
  const parts = [node("span", "", `上下文：${messages}，${notes ? `外加 ${notes} 条选入的页边批注。` : "页边批注默认不带。"}`), pick];
  if (chosen) parts.push(button("改回全部", "clear-context"));
  scope.replaceChildren(...parts);
  renderMemories("main-memory-list", "main-memory-choices", memoryIds);
}

function renderToolDetails(tools = []) {
  if (!tools.length) return null;
  const details = node("details", "tool-details");
  const summary = node("summary", "", `工具调用 · ${tools.length} 项`);
  const list = node("div", "tool-list");
  for (const item of tools) {
    const row = node("div", "tool-item");
    row.append(node("span", `tool-status is-${item.status || "done"}`,
      item.status === "running" ? "◌" : item.status === "failed" ? "!" : "✓"),
    node("strong", "", item.title || "工具调用"));
    if (item.detail) row.append(node("span", "tool-detail", item.detail));
    list.append(row);
  }
  details.append(summary, list);
  return details;
}

function renderSelectionBar() {
  get("message-selection-bar").hidden = !selectingMessages || activeView !== "document";
  get("message-selection-count").textContent = choosingContext
    ? `已选 ${selectedMessages.size} 条消息 · ${selectedNotes.size} 条批注` : `已选 ${selectedMessages.size} 条`;
  actionButton("select-messages").setAttribute("aria-pressed", String(selectingMessages));
  actionButton("new-chat-from-selection").disabled = !selectedMessages.size;
  actionButton("new-chat-from-selection").hidden = choosingContext;
  actionButton("set-context").hidden = !choosingContext;
  actionButton("context-select-all").hidden = actionButton("context-select-none").hidden = !choosingContext;
  get("message-selection-hint").textContent = choosingContext
    ? "选中的消息和批注加上之后的新消息会发给模型；批注默认不进入上下文" : "回答会自动带上对应提问；批注和分支也会复制";
}

// Messages that can be picked as context (the ones drawn in the stream, removed ones aside).
function contextGroupIds() {
  return messageGroups(state.blocks).filter((group) => group.blocks.some((block) => !block.removed))
    .map((group) => group.blocks[0].id);
}

function inlineEditor(author) {
  const panel = node("div", "inline-editor");
  const tabs = node("div", "inline-editor-tabs");
  const editTab = button("编辑", "editor-edit-tab");
  const previewTab = button("预览", "editor-preview-tab");
  editTab.setAttribute("aria-pressed", String(!editingMessage.preview));
  previewTab.setAttribute("aria-pressed", String(editingMessage.preview));
  tabs.append(editTab, previewTab);
  panel.append(tabs);
  if (editingMessage.preview) {
    const preview = node("div", "inline-preview body-text markdown-content");
    renderMarkdown(preview, editingMessage.text || "*空白笔记块*");
    panel.append(preview);
  } else {
    const input = node("textarea", "message-editor");
    input.value = editingMessage.text;
    input.maxLength = 160_000;
    input.setAttribute("aria-label", `编辑${author}`);
    input.style.minHeight = `${Math.max(100, Math.min(560, editingMessage.height || 120))}px`;
    panel.append(input);
  }
  const actions = node("div", "inline-editor-actions");
  const include = node("input", "include-block");
  include.type = "checkbox";
  include.checked = editingMessage.included;
  const label = node("label");
  label.append(include, editingMessage.kind === "note" ? "用于 AI 上下文" : "用于主对话");
  actions.append(label, button("取消", "cancel-message-edit"));
  if (editingMessage.kind === "agent") actions.append(button("保存并转为笔记", "save-and-convert"));
  const save = button("保存", "save-message-edit", "primary");
  actions.append(save);
  panel.append(actions);
  return panel;
}

// A thin hover bar between messages, like the gap between notebook cells.
// afterId is the last block before the gap (null at the top); beforeId the first block after it.
function insertGap(afterId, beforeId) {
  const gap = node("div", "insert-gap");
  gap.dataset.afterId = afterId ?? "";
  gap.dataset.beforeId = beforeId ?? "";
  const tools = node("div", "insert-gap-tools");
  const text = button("＋ 笔记块", "insert-note-here");
  const image = button("＋ 图片", "insert-image-here");
  text.title = "在这里插入笔记块";
  image.title = "在这里插入图片";
  tools.append(text, image);
  gap.append(node("span", "insert-gap-line"), tools, node("span", "insert-gap-line"));
  return gap;
}

function draftRow() {
  const row = node("div", "chat-row is-note is-draft");
  const message = node("article", "paper-block is-note editing-inline");
  message.style.width = `${editingMessage.width || 600}px`;
  const meta = node("div", "message-meta");
  meta.append(node("strong", "", "新笔记块"));
  message.append(meta, inlineEditor("笔记块"));
  row.append(node("span", "note-symbol", "✦"), message);
  return row;
}

// Groups that are drawn in the stream, in document order.
function visibleGroups() {
  return messageGroups(state.blocks).filter((group) => group.blocks.some((block) => !block.removed) ||
    state.notes.some((note) => group.blocks.some((block) => block.id === note.anchor.blockId)));
}

function renderDocument() {
  const title = get("document-title");
  title.textContent = state.title;
  const origin = state.origin;
  get("notebook-origin").hidden = !origin;
  if (origin) {
    get("origin-reference").textContent = [origin.reference, origin.title].filter(Boolean).join(" · ");
    get("origin-quote").textContent = origin.quote;
    get("origin-quote").hidden = !origin.quote;
    renderMarkdown(get("origin-comment"), origin.text);
  }
  const fragments = document.createDocumentFragment();
  const groups = visibleGroups();
  const allowed = contextBlockIds(state);
  if (activeMessage && !groups.some((group) => group.blocks[0].id === activeMessage)) activeMessage = undefined;
  const draft = editingMessage?.id === "new-shared" ? editingMessage : null;
  let draftPlaced = false;
  const placeGap = (afterId, beforeId) => {
    // A draft with afterId undefined (or one whose spot vanished) lands at the end.
    const here = draft && !draftPlaced && (draft.afterId === afterId || beforeId === null);
    if (here) {
      draftPlaced = true;
      draft.afterId = afterId;
      fragments.append(draftRow(), node("div", "margin-slot"));
    } else if (!editingMessage) fragments.append(insertGap(afterId, beforeId));
  };
  let source;
  let previousId = null;
  for (const group of groups) {
    if (group.kind === "question") source = group.blocks[0].source;
    // Group replies carry their own speaker; older replies fall back to the question's account.
    const speaker = group.kind === "reply" ? group.blocks[0].source ?? source : source;
    const ids = new Set(group.blocks.map((block) => block.id));
    const attached = state.notes.filter((note) => ids.has(note.anchor.blockId));
    const visible = group.blocks.filter((block) => !block.removed);
    const kind = group.kind === "question" ? "user" : group.kind === "reply" ? "agent" : "note";
    const row = node("div", `chat-row is-${kind}`);
    if (allowed && !group.blocks.some((block) => allowed.has(block.id))) {
      row.classList.add("out-of-context");
      row.title = "不在主对话上下文里";
    }
    const messageId = group.blocks[0].id;
    const editingThis = editingMessage?.id === messageId;
    placeGap(previousId, messageId);
    row.dataset.messageId = messageId;
    row.dataset.afterId = previousId ?? "";
    row.classList.toggle("active", messageId === activeMessage);
    row.classList.toggle("pick-source", messageId === annotationPick?.messageId);
    // Only messages appearing for the first time play the arrival animation, not every re-render.
    if (renderedMessages.has(messageId)) row.classList.add("settled");
    renderedMessages.add(messageId);
    previousId = group.blocks.at(-1).id;
    const image = kind === "note" && visible[0]?.noteType === "image" ? visible[0].attachments?.[0] : null;
    const message = node("article", `paper-block is-${kind}`);
    if (editingThis) {
      message.classList.add("editing-inline");
      message.style.width = `${editingMessage.width || 600}px`;
    }
    const author = kind === "user" ? "你" : kind === "agent" ? speakerName(speaker) : image ? "图片笔记" : "笔记块";
    const meta = node("div", "message-meta");
    if (kind === "note") {
      const handle = node("span", "shared-drag-handle", "⠿");
      handle.draggable = !editingMessage;
      handle.dataset.sharedId = messageId;
      handle.title = "拖动到任意位置";
      handle.setAttribute("aria-label", "拖动笔记块");
      meta.append(handle);
    }
    meta.append(node("strong", "", author));
    // Which service actually answered, at a glance; the avatar is the member's own choice.
    if (kind === "agent" && speaker) {
      meta.append(node("span", `provider-badge is-${speaker.provider || "gpt"}`, providerName(speaker.provider)),
        node("span", "", [speaker.model, speaker.effort].filter(Boolean).join(" · ") || "默认模型"));
    }
    if (kind === "note" && visible.length && !sharedNoteIncluded(visible[0])) {
      meta.append(node("span", "shared-context-off", "未用于 AI 上下文"));
    }
    const collapse = iconButton("fold", "toggle-message", collapsedMessages.has(messageId) ? "展开消息" : "收起消息");
    collapse.classList.add("message-collapse");
    collapse.disabled = editingThis;
    collapse.dataset.messageId = messageId;
    collapse.setAttribute("aria-expanded", String(!collapsedMessages.has(messageId)));
    const edit = iconButton("edit", "edit-message", "编辑这条消息");
    edit.dataset.messageId = messageId;
    const remove = iconButton("trash", "delete-message", "移除这条消息");
    remove.dataset.messageId = messageId;
    meta.append(collapse, edit, remove);
    // Any message can become a note block (questions too) or move out of the chat into an annotation.
    if (visible.length) {
      if (kind !== "note") {
        const convert = iconButton("note", "convert-message", "转为笔记块");
        convert.dataset.messageId = messageId;
        convert.disabled = editingThis;
        meta.append(convert);
      }
      const toMargin = iconButton("margin", "message-to-annotation", "转为页边批注（移出主对话）");
      toMargin.dataset.messageId = messageId;
      toMargin.disabled = editingThis;
      meta.append(toMargin);
    }
    message.append(meta);
    const contentBody = node("div", "message-content");
    contentBody.hidden = collapsedMessages.has(messageId) && !editingThis;
    if (!visible.length) {
      contentBody.append(node("p", "removed-block", "原消息已移除"));
    } else if (editingThis) {
      contentBody.append(inlineEditor(author));
    } else {
      if (image) {
        const picture = node("img", "shared-image");
        picture.src = `notebook://app/note-image/${image.id}`;
        picture.alt = visible[0].text || image.name;
        picture.loading = "lazy";
        contentBody.append(picture);
      }
      for (const block of visible) {
        const element = kind === "user" ? node("div", "body-text") :
          node("div", "body-text markdown-content");
        element.dataset.blockId = block.id;
        markedText(element, block, attached.filter((note) => note.anchor.blockId === block.id));
        if (kind !== "note" && block.included === false) contentBody.append(node("span", "context-excluded", "仅显示"));
        contentBody.append(element);
        if (block.attachments?.length && !image) contentBody.append(sentAttachments(block.attachments));
      }
    }
    if (kind === "agent" && !editingThis) {
      const toolLog = group.blocks.find((block) => block.tools?.length)?.tools;
      const details = renderToolDetails(toolLog);
      if (details) contentBody.prepend(details);
    }
    if (contentBody.hidden) {
      const preview = visible.map((block) => block.text).join(" ").replace(/\s+/g, " ").slice(0, 90);
      message.append(node("p", "message-preview", preview || "消息已收起"));
    }
    message.append(contentBody);
    if (selectingMessages && !editingMessage) {
      const select = node("input", "message-select");
      select.type = "checkbox";
      select.checked = selectedMessages.has(messageId);
      select.dataset.messageId = messageId;
      select.setAttribute("aria-label", `选择${author}的消息`);
      row.append(select);
      row.classList.toggle("selected", select.checked);
    }
    if (kind === "user") {
      row.append(message, pixelAvatar(appearance().userAvatar, "idle", "我的头像"));
    } else if (kind === "agent") {
      row.append(pixelAvatar(speakerAvatar(speaker), "idle", `${author} 头像`), message);
    } else {
      row.append(node("span", "note-symbol", "✦"), message);
    }
    const margin = node("div", "margin-slot");
    margin.append(...attached.map(annotation));
    fragments.append(row, margin);
  }
  placeGap(previousId, null);
  get("blocks").replaceChildren(fragments);
  renderSelectionBar();
  get("note-count").textContent = `${state.notes.length} 条`;
  get("document-grid").classList.toggle("notes-hidden", !notesVisible);
  renderMainContext();
  renderWorkDir();
  renderLibrary();
  if (activeView === "document") document.title = `${state.title} · AI 笔记本`;
}

function showNotes(visible) {
  notesVisible = visible;
  get("document-grid").classList.toggle("notes-hidden", !visible);
  actionButton("toggle-notes").setAttribute("aria-pressed", String(visible));
}

function updateView() {
  document.body.dataset.view = activeView;
  document.title = `${activeView === "pdf" ? "PDF 审阅" : activeView === "canvas" ? "分支画布" :
    activeView === "apps" ? "应用与账户" : state?.title || "AI 笔记本"} · AI 笔记本`;
  get("document-view").hidden = activeView !== "document";
  get("canvas-view").hidden = activeView !== "canvas";
  get("pdf-view").hidden = activeView !== "pdf";
  get("apps-view").hidden = activeView !== "apps";
  for (const tab of document.querySelectorAll("[data-view]")) {
    if (tab.dataset.view === activeView) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (activeView === "canvas") renderCanvas();
  if (activeView === "pdf") pdfReview.activate();
  if (activeView === "apps") openApps().catch((error) => say(error.message));
  renderSelectionBar();
}

function setFocus(mode, noteId = null) {
  focusMode = mode;
  focusedNoteId = noteId;
  document.body.dataset.focus = mode || "";
  get("focus-shade").hidden = !mode;
  get("focus-bar").hidden = !mode;
  if (mode) {
    get("focus-parent").textContent = state?.title || "主聊天";
    get("focus-title").textContent = mode === "pdf" ? "PDF 审阅" : mode === "branch" ?
      branchTitle(currentBranch()) : "批注与追问";
  }
}

function closeFocus() {
  if (focusMode === "pdf") {
    activeView = "document";
    updateView();
    chatOpen(false);
  } else if (focusMode === "branch") {
    chatOpen(false);
  }
  setFocus(null);
  if (activeView === "document") renderDocument();
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
      node("p", "reply-source", `${speakerName(turn.source)} · ${sourceLabel(turn.source)}`));
    const toolLog = renderToolDetails(turn.tools);
    if (toolLog) article.append(toolLog);
    article.append(reply, controls);
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
  setFocus("branch");
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
      `${branch.turns.length ? `${speakerName(branch.turns.at(-1).source)} · ` : ""}${branch.turns.length} 轮`));
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

function showEditor({ heading, reference, text = "", limit = 60_000, rows = 7, folderId, folderOnly = false, save }) {
  get("editor-heading").textContent = heading;
  get("editor-reference").hidden = !reference;
  get("editor-reference").textContent = reference || "";
  get("editor-text").maxLength = limit;
  get("editor-text").rows = rows;
  get("editor-text").value = text;
  get("editor-text").hidden = folderOnly;
  get("editor-text").required = !folderOnly;
  get("editor-folder-row").hidden = folderId === undefined;
  if (folderId !== undefined) {
    get("editor-folder").replaceChildren(option("", "未分类"),
      ...libraryFolders.map((folder) => option(folder.id, folder.name)));
    get("editor-folder").value = folderId || "";
  }
  editorSave = save;
  get("editor").showModal();
  (folderOnly ? get("editor-folder") : get("editor-text")).focus();
}

function option(value, label, disabled = false) {
  const item = node("option", "", label);
  item.value = value;
  item.disabled = disabled;
  return item;
}

function applyAppearance() {
  document.body.dataset.chatBackground = appearance().background;
}

function renderAppearanceChoices() {
  const selected = appearance();
  const backgrounds = [
    ["garden", "薄荷花园"], ["sky", "晴空"], ["paper", "暖纸"], ["night", "夜航"]
  ];
  get("background-options").replaceChildren(...backgrounds.map(([id, label]) => {
    const choice = button("", "appearance-background", "background-choice");
    choice.dataset.background = id;
    choice.setAttribute("aria-pressed", String(selected.background === id));
    choice.append(node("span", "background-preview"), node("span", "", label));
    return choice;
  }));
  const roles = [
    ["userAvatar", "我的头像"], ["gptAvatar", "GPT 头像"], ["claudeAvatar", "Claude 头像"]
  ];
  get("avatar-options").replaceChildren(...roles.map(([key, label]) => {
    const group = node("section", "avatar-choice-group");
    group.append(node("h4", "", label));
    const choices = node("div", "avatar-choice-list");
    choices.append(...avatarChoices.map(({ id, label: name }) => {
      const choice = button("", "appearance-avatar", "avatar-choice");
      choice.dataset.avatarRole = key;
      choice.dataset.avatarKind = id;
      choice.setAttribute("aria-pressed", String(selected[key] === id));
      choice.title = name;
      choice.setAttribute("aria-label", `${label}：${name}`);
      choice.append(pixelAvatar(id, "idle", ""), node("span", "", name));
      return choice;
    }));
    group.append(choices);
    return group;
  }));
}

// Model and effort choices for one member, from the models its account offers.
function fillModelPickers(picker, effortPicker, provider, models, model, effort, busy = false) {
  const fallback = models.find((item) => item.isDefault) || models[0];
  const defaults = provider === "gpt" && fallback ? `自动 · ${fallback.label}` : fallback?.label || "自动";
  picker.replaceChildren(option("", defaults), ...models.filter((item) => item.id).map((item) => option(item.id, item.label)));
  const selected = model ? models.find((item) => item.id === model) : fallback;
  if (model && !selected) picker.append(option(model, model, true));
  picker.value = model;
  picker.disabled = !models.length || busy;
  const levels = selected?.efforts || [];
  effortPicker.replaceChildren(option("", selected?.defaultEffort ? `自动 · ${selected.defaultEffort}` : "自动"),
    ...levels.map((level) => option(level, level)));
  if (effort && !levels.includes(effort)) effortPicker.append(option(effort, effort, true));
  effortPicker.value = effort;
  effortPicker.disabled = !levels.length || busy;
}

function renderSettings() {
  const profile = currentProfile();
  const member = defaultMember();
  if (!profile || !member) return;
  const provider = providerName(profile.provider);
  const picker = get("member-picker");
  picker.replaceChildren(...members().map((item) => {
    const owner = profileOf(item);
    return option(item.id, `${item.name} · ${providerName(owner?.provider)}${owner && !owner.native ? ` · ${owner.name}` : ""}`);
  }));
  picker.value = member.id;
  picker.disabled = settingsBusy;
  picker.title = `没有 @ 时由「${member.name}」回答；账户：${providerName(profile.provider)} · ${profile.name}`;
  const status = get("account-status");
  status.textContent = account.message || (account.signedIn ? `${account.plan?.toUpperCase() || "订阅"} · 已登录` : "未登录");
  status.title = account.email || status.textContent;
  document.querySelector(".account").classList.toggle("connected", Boolean(account.signedIn));
  get("login").disabled = logins.has(profile.id);
  get("login").textContent = logins.has(profile.id) ? "登录中" : account.signedIn ? "重新登录" : "登录";
  get("main-prompt-label").textContent = `群聊提问 · 默认由 ${member.name} 回答，输入 @ 指定成员`;
  get("chat-provider").textContent = `${member.name} · ${provider}`;
  get("model-label").title = `默认成员 ${member.name} 的模型和 Effort；其他成员在「成员与额度」里设置`;
  fillModelPickers(get("model-picker"), get("effort-picker"), profile.provider, account.models || [],
    member.model, member.effort || "", settingsBusy);
  renderMentionBar();
}

async function refreshAccount() {
  const profile = currentProfile();
  if (!profile) return;
  const serial = ++accountCheck;
  account = { message: "正在检查" };
  renderSettings();
  try {
    const result = await api.account(profile.id);
    accountCache.set(profile.id, result);
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
  const oldProfileId = currentProfile()?.id;
  settingsBusy = true;
  renderSettings();
  try {
    settings = await api.setSetting(action);
  } finally {
    settingsBusy = false;
    if (currentProfile()?.id === oldProfileId) renderSettings();
    else void refreshAccount();
    if (/^(member|account)/.test(action.type)) {
      renderDocument();
      renderPending();
      refreshPanels();
    }
    if (action.type === "appearance") {
      applyAppearance();
      renderAppearanceChoices();
      renderDocument();
      renderPending();
    }
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
      if (kind === "main") {
        const user = node("div", "chat-row is-user pending-message");
        const question = node("article", "paper-block is-user");
        question.append(node("div", "message-meta", "你"), node("div", "body-text", currentTurn.question));
        user.append(question, pixelAvatar(appearance().userAvatar, "idle", "我的头像"));
        const agent = node("div", "chat-row is-agent pending-message");
        const reply = node("article", "paper-block is-agent");
        const header = node("div", "pending-header");
        const queue = currentTurn.queue || [];
        const position = queue.length > 1 ? `（${currentTurn.index + 1}/${queue.length}）` : "";
        header.append(node("p", "muted", `${currentTurn.provider}${position} ${currentTurn.activity || "正在思考"}`),
          button("停止", "stop"));
        const output = node("div", "pending-output markdown-content");
        renderMarkdown(output, currentTurn.text);
        if (!currentTurn.text) output.append(node("span", "typing-dots", "● ● ●"));
        const waiting = queue.slice(currentTurn.index + 1).map((item) => item.name);
        if (waiting.length) header.append(node("p", "pending-queue", `接下来：${waiting.join("、")}`));
        reply.append(header);
        const toolLog = renderToolDetails(currentTurn.tools);
        if (toolLog) reply.append(toolLog);
        reply.append(output);
        const avatar = pixelAvatar(currentTurn.avatar || avatarFor(currentTurn.profileProvider),
          currentTurn.activity?.includes("搜索") ? "searching" : currentTurn.text ? "typing" : "thinking",
          `${currentTurn.provider} 头像`);
        agent.append(avatar, reply);
        // Once the first member has answered, the question is already in the document.
        if (currentTurn.questionSaved) pending.append(agent);
        else pending.append(user, agent);
      } else {
        const header = node("div", "pending-header");
        header.append(node("p", "muted", `${currentTurn.provider} ${currentTurn.activity || "正在回答"}`),
          button("停止", "stop"));
        const output = node("div", "pending-output markdown-content");
        renderMarkdown(output, currentTurn.text);
        pending.append(header, node("p", "question-bubble", currentTurn.question));
        const toolLog = renderToolDetails(currentTurn.tools);
        if (toolLog) pending.append(toolLog);
        pending.append(output);
      }
    }
    const form = get(`${kind}-form`);
    const key = draftKey(kind);
    const refs = draftFiles.get(key) || [];
    const chips = get(`${kind}-attachments`);
    chips.hidden = !refs.length;
    chips.replaceChildren(...refs.map((ref) => attachmentChip(ref, kind)));
    get(`${kind}-question`).required = refs.length === 0;
    const select = form.querySelector('[data-action="choose-files"]');
    select.disabled = !key || Boolean(editingMessage) || stagingFiles.has(key) || currentTurn?.fileKey === key;
    form.querySelector('button[type="submit"]').disabled = Boolean(currentTurn) || Boolean(editingMessage) || stagingFiles.has(key);
  }
  actionButton("delete-chat").disabled = Boolean(currentTurn?.branchId && currentTurn.branchId === currentBranchId);
}

async function sendQuestion(kind) {
  const input = get(`${kind}-question`);
  const question = input.value.trim();
  const notebookId = state.id;
  const fileKey = draftKey(kind);
  if ((!question && !draftFiles.get(fileKey)?.length) || !fileKey || currentTurn || editingMessage ||
      settingsBusy || stagingFiles.has(fileKey)) return;
  const branchId = kind === "side" ? currentBranchId : undefined;
  if (kind === "side" && !branchId) return;
  const files = draftFiles.get(fileKey) || [];
  if ((!question && !files.length) || stagingFiles.has(fileKey) || editingMessage) return;
  // @名字 picks who answers (a side chat takes the first one); nobody named means the default member.
  const named = mentionedMembers(question).found;
  const queue = (named.length ? named : [defaultMember()]).slice(0, branchId ? 1 : 8);
  const first = queue[0];
  const requestId = crypto.randomUUID();
  currentTurn = { requestId, branchId, notebookId, question: question || "请概述附件的主要内容。",
    fileKey, provider: first.name, avatar: first.avatar, profileProvider: profileOf(first)?.provider,
    queue, index: 0, text: "", tools: [] };
  renderPending();
  try {
    accept(await api.send({ requestId, branchId, question, memberIds: named.length ? queue.map((item) => item.id) : [],
      notebookId, attachmentIds: files.map((ref) => ref.id) }));
    draftFiles.delete(fileKey);
    if (branchId) {
      if (sideDrafts.get(branchId)?.trim() === question) sideDrafts.delete(branchId);
    } else if (state.id === notebookId) {
      if (input.value.trim() === question) {
        input.value = "";
        renderMentionHint();
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
  if (!key || !selected.length || editingMessage || stagingFiles.has(key) || currentTurn?.fileKey === key) return;
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

function startMessageEdit(id, card) {
  if (editingMessage || editingNote) throw new Error("请先保存或取消当前编辑。");
  if (currentTurn?.notebookId === state.id) throw new Error("请等待当前回答完成后再编辑消息。");
  const group = messageGroups(state.blocks).find((item) => item.blocks[0].id === id);
  if (!group) throw new Error("这条消息已不存在。");
  editingMessage = {
    id, ids: group.blocks.map((block) => block.id),
    kind: group.kind === "reply" ? "agent" : group.kind === "question" ? "user" : "note",
    text: group.blocks.filter((block) => !block.removed).map((block) => block.text).join("\n\n"),
    included: group.kind === "paragraph" ? sharedNoteIncluded(group.blocks[0]) :
      group.blocks.filter((block) => !block.removed).every((block) => block.included !== false),
    width: card?.offsetWidth || 600,
    height: card?.querySelector(".message-content, .shared-card-content")?.offsetHeight || 120,
    preview: false
  };
  renderDocument();
  renderPending();
  document.querySelector(".editing-inline .message-editor")?.focus();
}

async function saveMessageEdit(convert = false) {
  const draft = editingMessage;
  if (!draft?.text.trim()) throw new Error("请输入内容；若要移除，请点删除图标。");
  if (draft.id === "new-shared") {
    const before = new Set(state.blocks.map((block) => block.id));
    await change({ type: "add-shared-block", text: draft.text, included: draft.included, afterId: draft.afterId });
    activeMessage = state.blocks.find((block) => !before.has(block.id))?.id ?? activeMessage;
  } else {
    await change({ type: "edit-document", title: state.title, messages: [{
      ids: draft.ids, text: draft.text, included: draft.included
    }] });
    if (convert) await change({ type: "convert-reply", ids: draft.ids });
  }
  editingMessage = null;
  renderDocument();
  renderPending();
  say(convert ? "回答已转为公共笔记。" : "消息已保存。");
}

async function addNoteImages(files, afterId = insertionPoint()) {
  if (editingMessage) throw new Error("请先保存或取消当前编辑。");
  const chosen = [...files];
  if (!chosen.length) return;
  const notebookId = state.id;
  const result = await api.addNoteImages(notebookId, chosen, afterId);
  if (state.id === notebookId) {
    accept(result.state);
    renderDocument();
  }
  if (result.errors.length) say(result.errors.join(" "));
  else say(`已插入 ${chosen.length} 张图片笔记。`);
}

// Last block of the message that new notes go after: the active message, else the end of the chat.
function insertionPoint(above = false) {
  const groups = visibleGroups();
  const index = groups.findIndex((group) => group.blocks[0].id === activeMessage);
  if (index < 0) return groups.at(-1)?.blocks.at(-1).id ?? null;
  const target = above ? groups[index - 1] : groups[index];
  return target ? target.blocks.at(-1).id : null;
}

function startNewNote(afterId) {
  if (editingMessage) throw new Error("请先保存或取消当前编辑。");
  if (currentTurn?.notebookId === state.id) throw new Error("请等待当前回答完成后再插入笔记块。");
  editingMessage = { id: "new-shared", ids: [], kind: "note", text: "", included: true,
    preview: false, width: 600, height: 120, afterId };
  renderDocument();
  renderPending();
  const editor = document.querySelector(".editing-inline .message-editor");
  editor?.closest(".chat-row")?.scrollIntoView({ block: "nearest" });
  editor?.focus();
}

function messageRows() {
  return Array.from(get("blocks").querySelectorAll(":scope > .chat-row[data-message-id]"));
}

function setActiveMessage(id, scroll = false) {
  activeMessage = id;
  for (const row of messageRows()) {
    row.classList.toggle("active", row.dataset.messageId === id);
    if (scroll && row.dataset.messageId === id) row.scrollIntoView({ block: "nearest" });
  }
}

function toggleSelected(id, on = !selectedMessages.has(id)) {
  if (on) selectedMessages.add(id);
  else selectedMessages.delete(id);
}

// Ctrl/⌘ toggles one message, Shift selects a range from the active message, like notebook cells.
function selectMessage(id, { toggle = false, range = false } = {}) {
  if (!toggle && !range && !selectingMessages) {
    setActiveMessage(id);
    return;
  }
  if (!selectingMessages) {
    selectingMessages = true;
    selectedMessages.clear();
    if (activeMessage && activeMessage !== id) selectedMessages.add(activeMessage);
  }
  const ids = messageRows().map((row) => row.dataset.messageId);
  if (range && activeMessage && ids.includes(activeMessage)) {
    const [from, to] = [ids.indexOf(activeMessage), ids.indexOf(id)].sort((a, b) => a - b);
    for (const item of ids.slice(from, to + 1)) selectedMessages.add(item);
  } else {
    toggleSelected(id);
  }
  if (!range) activeMessage = id;
  renderDocument();
}

function redrawNotes() {
  renderDocument();
  renderChat();
}

async function handleAction(control) {
  const action = control.dataset.action;
  if (editingNote && !["note-edit-tab", "note-preview-tab", "cancel-note-edit", "save-note-edit"].includes(action)) {
    throw new Error("请先保存或取消当前批注的编辑。");
  }
  if (editingMessage && ["ask", "branch", "note", "highlight", "underline", "locate-note",
    "locate-branch", "extract", "edit-note", "pin-note", "delete-note", "toggle-note", "select-messages"].includes(action)) {
    throw new Error("请先保存或取消当前编辑。");
  }
  const noteId = control.closest("[data-note-id]")?.dataset.noteId;
  const note = noteId && state.notes.find((item) => item.id === noteId);
  const turnId = control.closest("[data-turn-id]")?.dataset.turnId;
  switch (action) {
    case "edit-message":
      startMessageEdit(control.dataset.messageId, control.closest(".paper-block, .shared-card"));
      break;
    case "editor-preview-tab":
    case "editor-edit-tab":
      editingMessage.preview = action === "editor-preview-tab";
      renderDocument();
      if (!editingMessage.preview) document.querySelector(".editing-inline .message-editor")?.focus();
      break;
    case "cancel-message-edit":
      editingMessage = null;
      renderDocument();
      renderPending();
      break;
    case "save-message-edit":
    case "save-and-convert":
      await saveMessageEdit(action === "save-and-convert");
      break;
    case "delete-message": {
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      const id = control.dataset.messageId;
      const group = messageGroups(state.blocks).find((item) => item.blocks[0].id === id);
      const ids = group?.blocks.map((block) => block.id) || [id];
      if (!window.confirm("移除这条消息？此操作会删除消息正文。")) break;
      await change({ type: "edit-document", title: state.title,
        messages: [{ ids, text: "", removed: true }] });
      selectedMessages.delete(id);
      renderDocument();
      break;
    }
    case "convert-reply":
    case "convert-message": {
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      const id = control.dataset.messageId;
      const group = messageGroups(state.blocks).find((item) => item.blocks[0].id === id);
      if (!group) throw new Error("消息已改变，请重试。");
      await change({ type: "convert-message", ids: group.blocks.map((block) => block.id) });
      activeMessage = state.blocks[state.blocks.findIndex((block) => block.id === group.blocks.at(-1).id) + 1]?.id;
      renderDocument();
      say("这条消息已替换为笔记块。");
      break;
    }
    case "message-to-annotation": {
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      const id = control.dataset.messageId;
      const group = messageGroups(state.blocks).find((item) => item.blocks[0].id === id);
      if (!group) throw new Error("消息已改变，请重试。");
      startAnnotationPick(id, group.blocks.map((block) => block.id));
      break;
    }
    case "pick-selection":
      if (!annotationPick) break;
      await finishAnnotationPick(anchor(true));
      break;
    case "pick-nearby":
      if (!annotationPick) break;
      await finishAnnotationPick(null);
      break;
    case "pick-cancel":
      stopAnnotationPick();
      break;
    case "new-shared-block":
      startNewNote(insertionPoint());
      break;
    case "insert-note-here":
      startNewNote(control.closest(".insert-gap").dataset.afterId || null);
      break;
    case "choose-note-images":
    case "insert-image-here":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      imageInsertAfter = action === "insert-image-here"
        ? control.closest(".insert-gap").dataset.afterId || null : insertionPoint();
      get("note-image-files").click();
      break;
    case "toggle-message": {
      const id = control.dataset.messageId;
      if (collapsedMessages.has(id)) collapsedMessages.delete(id);
      else collapsedMessages.add(id);
      renderDocument();
      break;
    }
    case "select-messages":
      selectingMessages = !selectingMessages;
      choosingContext = false;
      selectedMessages.clear();
      selectedNotes.clear();
      renderDocument();
      break;
    case "cancel-message-selection":
      selectingMessages = choosingContext = false;
      selectedMessages.clear();
      selectedNotes.clear();
      renderDocument();
      break;
    case "choose-context":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      selectingMessages = true;
      choosingContext = true;
      selectedMessages.clear();
      selectedNotes.clear();
      // Start from what is used now: every message when nothing was chosen.
      for (const id of state.context?.ids ?? contextGroupIds()) selectedMessages.add(id);
      for (const id of state.context?.notes || []) selectedNotes.add(id);
      showNotes(true);
      renderDocument();
      say("勾选要作为上下文的消息和页边批注（也可按住 Ctrl/Shift 点选消息），然后点底部的「设为上下文」。");
      break;
    case "context-select-all":
    case "context-select-none": {
      const all = action === "context-select-all";
      selectedMessages.clear();
      selectedNotes.clear();
      if (all) {
        for (const id of contextGroupIds()) selectedMessages.add(id);
        for (const note of state.notes) selectedNotes.add(note.id);
      }
      renderDocument();
      break;
    }
    case "set-context": {
      // Every message ticked means "all earlier messages", as by default.
      const groups = contextGroupIds();
      const everything = groups.length > 0 && groups.every((id) => selectedMessages.has(id));
      await change({ type: "set-context", ids: everything ? null : [...selectedMessages], noteIds: [...selectedNotes] });
      selectingMessages = choosingContext = false;
      selectedMessages.clear();
      selectedNotes.clear();
      renderDocument();
      say(state.context ? "之后的提问按你的选择带上下文；之后的新消息会自动加入。" : "上下文是全部之前的消息，不带批注。");
      break;
    }
    case "clear-context":
      await change({ type: "clear-context" });
      renderDocument();
      say("上下文已改回全部之前的消息。");
      break;
    case "new-chat-from-selection":
      if (!selectedMessages.size) throw new Error("请先选择至少一条消息。");
      await switchNotebook(() => api.createFromMessages(state.id, [...selectedMessages]));
      say("已从所选消息建立新聊天。");
      break;
    case "choose-work-dir": {
      const notebookId = state.id;
      const next = await api.chooseFolder(notebookId);
      if (next && state.id === notebookId) {
        accept(next);
        renderDocument();
        say(`模型会在「${next.workDir}」里工作。`);
      }
      break;
    }
    case "open-work-dir":
      await api.openFolder(state.id);
      break;
    case "clear-work-dir":
      await change({ type: "clear-work-dir" });
      renderDocument();
      say("已改回默认工作文件夹。");
      break;
    case "open-data":
      await openDataDialog();
      break;
    case "close-data":
      get("data-dialog").close();
      break;
    case "data-open-folder":
    case "data-open-backups":
      await api.openDataFolder(action === "data-open-backups" ? "backups" : "data");
      break;
    case "data-backup":
      control.disabled = true;
      try {
        renderDataInfo(await api.backupNow());
        say("已备份。");
      } finally {
        control.disabled = false;
      }
      break;
    case "data-export": {
      control.disabled = true;
      try {
        const result = await api.exportBackup();
        if (result) say(`已导出到「${result.file}」（${result.size}）。`);
      } finally {
        control.disabled = false;
      }
      break;
    }
    case "data-import":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      await api.importBackup();
      break;
    case "data-restore":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      await api.restoreBackup(control.dataset.backup);
      break;
    case "data-move":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      await api.moveData();
      break;
    case "appearance":
      renderAppearanceChoices();
      get("appearance-dialog").showModal();
      break;
    case "close-appearance":
      get("appearance-dialog").close();
      break;
    case "appearance-background":
      await changeSetting({ type: "appearance", appearance: { background: control.dataset.background } });
      break;
    case "appearance-avatar":
      await changeSetting({ type: "appearance", appearance: {
        [control.dataset.avatarRole]: control.dataset.avatarKind
      } });
      break;
    case "toggle-library": {
      const sidebar = get("notebook-library");
      sidebar.hidden = !sidebar.hidden;
      control.setAttribute("aria-expanded", String(!sidebar.hidden));
      break;
    }
    case "new-notebook":
    case "new-notebook-in-folder":
      if (editingMessage) throw new Error("请先保存或取消当前编辑。");
      showEditor({
        heading: "新建会话", text: "", limit: 160, rows: 2,
        folderId: action === "new-notebook-in-folder" ? control.dataset.folderId : state.folderId || "",
        save: (title, folderId) => switchNotebook(() => api.createNotebook(title, folderId))
      });
      break;
    case "new-folder":
      showEditor({ heading: "新建主题", text: "", limit: 80, rows: 2,
        save: async (name) => {
          const result = await api.createFolder(name);
          libraryFolders = result.folders;
          renderLibrary();
        } });
      break;
    case "toggle-folder":
      if (collapsedFolders.has(control.dataset.folderId)) collapsedFolders.delete(control.dataset.folderId);
      else collapsedFolders.add(control.dataset.folderId);
      renderLibrary();
      break;
    case "rename-folder": {
      const folder = libraryFolders.find((item) => item.id === control.dataset.folderId);
      if (!folder) throw new Error("这个主题已不存在。");
      showEditor({ heading: "重命名主题", text: folder.name, limit: 80, rows: 2,
        save: async (name) => {
          const result = await api.renameFolder(folder.id, name);
          libraryFolders = result.folders;
          renderLibrary();
        } });
      break;
    }
    case "delete-folder": {
      const folder = libraryFolders.find((item) => item.id === control.dataset.folderId);
      if (!folder || !window.confirm(`删除主题「${folder.name}」？其中的会话会移到“未分类”。`)) break;
      const result = await api.deleteFolder(folder.id);
      libraryFolders = result.folders;
      libraryItems = result.items;
      if (state.folderId === folder.id) delete state.folderId;
      collapsedFolders.delete(folder.id);
      renderLibrary();
      break;
    }
    case "rename-notebook": {
      const item = libraryItems.find((entry) => entry.id === control.dataset.notebookId);
      if (!item) throw new Error("这个会话已不存在。");
      showEditor({ heading: "重命名会话", text: item.title, limit: 160, rows: 2,
        save: async (title) => {
          const result = await api.renameNotebook(item.id, title);
          accept(result.state);
          libraryItems = result.items;
          renderDocument();
        } });
      break;
    }
    case "move-notebook": {
      const item = libraryItems.find((entry) => entry.id === control.dataset.notebookId);
      if (!item) throw new Error("这个会话已不存在。");
      showEditor({ heading: "移动会话到主题", reference: item.title, folderOnly: true,
        folderId: item.folderId || "",
        save: async (_title, folderId) => {
          const result = await api.moveNotebook(item.id, folderId);
          accept(result.state);
          libraryItems = result.items;
          renderDocument();
        } });
      break;
    }
    case "delete-notebook": {
      const item = libraryItems.find((entry) => entry.id === control.dataset.notebookId);
      if (!item || !window.confirm(`删除会话「${item.title}」？其中的消息和批注将一并删除。`)) break;
      if (item.id === state.id) await switchNotebook(() => api.deleteNotebook(item.id));
      else {
        const result = await api.deleteNotebook(item.id);
        libraryItems = result.items;
        renderLibrary();
      }
      break;
    }
    case "open-notebook":
      if (control.dataset.notebookId === state.id) {
        activeView = "document";
        updateView();
      } else {
        await switchNotebook(() => api.openNotebook(control.dataset.notebookId));
      }
      break;
    case "open-notebook-window":
      await api.openNotebookWindow(control.dataset.notebookId);
      say("会话已在新窗口打开，可拖到另一台显示器。");
      break;
    case "choose-files":
      get(`${control.dataset.composer}-files`).click();
      break;
    case "open-attachment":
      if (storedAttachment(control.dataset.attachmentId)?.extension === ".pdf") {
        if (!await pdfReview.openAttachment(control.dataset.attachmentId)) break;
        activeView = "pdf";
        updateView();
        setFocus("pdf");
      } else {
        await api.openAttachment(control.dataset.attachmentId);
      }
      break;
    case "remove-attachment": {
      const key = draftKey(control.dataset.composer);
      await api.removeAttachment(control.dataset.attachmentId);
      draftFiles.set(key, (draftFiles.get(key) || []).filter((ref) => ref.id !== control.dataset.attachmentId));
      renderPending();
      break;
    }
    case "login": {
      const profile = control.dataset.profileId ? settings.profiles.find((item) => item.id === control.dataset.profileId)
        : currentProfile();
      if (!profile || logins.has(profile.id)) return;
      logins.add(profile.id);
      renderSettings();
      try {
        if (profile.provider === "claude") say("请在 Claude Code 打开的窗口中完成登录。");
        if (profile.provider === "gemini") say("请在打开的 Antigravity 窗口里用 Google 账户登录，登录完成后关闭那个窗口。");
        await api.login(profile.id);
        if (profile.provider === "gpt") say("请在浏览器中完成 ChatGPT 登录。");
      } finally {
        logins.delete(profile.id);
        renderSettings();
        refreshPanels();
      }
      break;
    }
    case "open-members":
      await openMembers();
      break;
    case "close-members":
      get("members-dialog").close();
      break;
    case "member-add":
      await changeMembers({ type: "member-add" });
      say("已添加成员，可以改名字、账户、模型和角色设定。");
      break;
    // Same account and model, new identity: a fresh name and an empty role prompt to fill in.
    case "member-clone": {
      const member = memberById(control.dataset.memberId);
      const added = await changeMembers({ type: "member-add", profileId: member.profileId, model: member.model,
        effort: member.effort, avatar: avatarChoices[(avatarChoices.findIndex((item) => item.id === member.avatar) + 3) % avatarChoices.length].id });
      openPrompts.add(added.id);
      renderMembers();
      say(`已用「${member.name}」的账户建了新身份「${added.name}」，写下它的角色设定吧。`);
      break;
    }
    case "members-import": {
      const added = await changeMembers({ type: "members-import" });
      say(added ? `已为 ${added} 个账户各建了一位成员。` : "每个账户在这个聊天里都已经有成员了。");
      break;
    }
    case "member-remove": {
      const member = memberById(control.dataset.memberId);
      if (member && window.confirm(`从这个聊天移除成员「${member.name}」？之前的回答会保留。`)) {
        await changeMembers({ type: "member-remove", id: member.id });
      }
      break;
    }
    case "member-default":
      await changeMembers({ type: "member-default", id: control.dataset.memberId });
      break;
    case "member-avatar": {
      const member = memberById(control.dataset.memberId);
      const next = avatarChoices[(avatarChoices.findIndex((item) => item.id === member.avatar) + 1) % avatarChoices.length];
      await changeMembers({ type: "member-update", id: member.id, avatar: next.id });
      break;
    }
    case "member-prompt-toggle": {
      const id = control.dataset.memberId;
      if (openPrompts.has(id)) openPrompts.delete(id);
      else openPrompts.add(id);
      renderMembers();
      break;
    }
    case "member-prompt-preset": {
      const box = control.closest(".member-card").querySelector(".member-prompt");
      box.value = rolePresets[control.dataset.preset];
      box.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    }
    case "apps-refresh":
      await openApps(true);
      say("已重新检查应用、登录和额度。");
      break;
    case "mention":
      insertMention(control.dataset.memberName);
      break;
    case "account-add": {
      const provider = control.dataset.provider;
      showEditor({
        heading: `新增 ${providerName(provider)} 账户`, reference: "为账户取个名字，例如「个人」或「工作」。会同时建一位使用这个账户的成员。",
        limit: 50, rows: 2,
        save: async (name) => {
          await changeSetting({ type: "account-add", provider, name });
          say("账户已新增。在成员页点这个账户的「登录」完成授权。");
        }
      });
      break;
    }
    case "account-remove": {
      const profile = settings.profiles.find((item) => item.id === control.dataset.profileId);
      if (profile && window.confirm(`删除账户「${profile.name}」和使用它的成员？登录文件会留在数据文件夹里。`)) {
        await changeSetting({ type: "account-remove", id: profile.id });
      }
      break;
    }
    case "account-limits":
      await loadLimits(control.dataset.profileId, true);
      break;
    case "refresh":
      await refreshAccount();
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
      if (note) {
        if (focusMode === "note") closeFocus();
        locate(note.anchor);
      }
      break;
    case "focus-note":
      if (!note) break;
      if (collapsedNotes.has(note.id)) collapsedNotes.delete(note.id);
      setFocus("note", note.id);
      renderDocument();
      break;
    case "toggle-note":
      if (!note) break;
      if (collapsedNotes.has(note.id)) collapsedNotes.delete(note.id);
      else collapsedNotes.add(note.id);
      renderDocument();
      break;
    case "edit-note":
      if (!note) break;
      editingNote = { id: note.id, text: note.text, preview: false };
      renderDocument();
      get("blocks").querySelector(`.annotation[data-note-id="${note.id}"] .note-inline-text`)?.focus();
      break;
    case "note-edit-tab":
    case "note-preview-tab":
      editingNote.preview = action === "note-preview-tab";
      renderDocument();
      if (!editingNote.preview) get("blocks").querySelector(`.annotation[data-note-id="${editingNote.id}"] .note-inline-text`)?.focus();
      break;
    case "cancel-note-edit":
      editingNote = null;
      renderDocument();
      break;
    case "save-note-edit":
      if (!editingNote?.text.trim()) throw new Error("请输入批注内容；若要删除，请点删除图标。");
      await change({ type: "edit-note", id: editingNote.id, text: editingNote.text });
      editingNote = null;
      redrawNotes();
      break;
    case "pin-note":
    case "delete-note":
      if (!note) return;
      if (action === "delete-note" && !window.confirm("删除这条批注及其追问？")) break;
      await change({ type: action, id: note.id });
      if (action === "delete-note") {
        if (focusedNoteId === note.id) closeFocus();
        commentChats.forget(`note:${state.id}:${note.id}`);
        collapsedNotes.delete(note.id);
      }
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
      setFocus(null);
      actionButton("ask").focus();
      break;
    case "locate-branch":
      setFocus(null);
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
      setFocus(null);
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
    case "close-focus":
      closeFocus();
      break;
    case "focus-branch":
      if (currentBranch()) setFocus("branch");
      break;
  }
}

document.addEventListener("selectionchange", captureSelection);
get("selection-tools").addEventListener("pointerdown", (event) => event.preventDefault());
window.addEventListener("scroll", () => { get("selection-tools").hidden = true; }, { capture: true, passive: true });
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) captureSelection();
});
get("document-view").addEventListener("pointerup", (event) => {
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
    if ((editingMessage || editingNote) && control.dataset.view !== "document") {
      say("请先保存或取消当前编辑。");
      return;
    }
    activeView = control.dataset.view;
    updateView();
    setFocus(activeView === "pdf" ? "pdf" : null);
  }
  try {
    await handleAction(control);
  } catch (error) {
    say(error.message);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && focusMode && !document.querySelector("dialog[open]") &&
      (focusMode !== "pdf" || get("review-box-layer").hidden)) closeFocus();
});
get("document-view").addEventListener("change", (event) => {
  const noteCheck = event.target.closest(".note-select");
  if (noteCheck) {
    if (noteCheck.checked) selectedNotes.add(noteCheck.dataset.noteId);
    else selectedNotes.delete(noteCheck.dataset.noteId);
    noteCheck.closest(".annotation")?.classList.toggle("selected", noteCheck.checked);
    renderSelectionBar();
  }
  const control = event.target.closest(".message-select");
  if (control) {
    if (control.checked) selectedMessages.add(control.dataset.messageId);
    else selectedMessages.delete(control.dataset.messageId);
    control.closest(".chat-row, .shared-card")?.classList.toggle("selected", control.checked);
    renderSelectionBar();
  }
  if (event.target.matches(".include-block") && editingMessage) editingMessage.included = event.target.checked;
});
get("document-view").addEventListener("input", (event) => {
  if (event.target.matches(".editing-inline .message-editor") && editingMessage) {
    editingMessage.text = event.target.value;
  }
  if (event.target.matches(".annotation .note-inline-text") && editingNote) editingNote.text = event.target.value;
});
get("note-image-files").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  addNoteImages(files, imageInsertAfter).catch((error) => say(error.message));
});

// Drop targets in the stream: a gap, or a message row (drops land just above it).
function dropSpot(target) {
  const gap = target.closest(".insert-gap");
  if (gap) return { element: gap, afterId: gap.dataset.afterId || null, beforeId: gap.dataset.beforeId || null };
  const row = target.closest("#blocks > .chat-row[data-message-id]");
  if (row) return { element: row, afterId: row.dataset.afterId || null, beforeId: row.dataset.messageId };
  return null;
}
const clearDropMarks = () => {
  for (const item of document.querySelectorAll(".drop-target")) item.classList.remove("drop-target");
};
get("blocks").addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".shared-drag-handle");
  if (!handle || editingMessage) return;
  event.dataTransfer.setData("application/x-ai-note-block", handle.dataset.sharedId);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setDragImage(handle.closest(".chat-row"), 20, 20);
});
get("blocks").addEventListener("dragover", (event) => {
  const types = event.dataTransfer.types;
  if (editingMessage || (!types.includes("Files") && !types.includes("application/x-ai-note-block"))) return;
  const spot = dropSpot(event.target);
  if (!spot) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
  if (!spot.element.classList.contains("drop-target")) {
    clearDropMarks();
    spot.element.classList.add("drop-target");
  }
});
get("blocks").addEventListener("dragleave", (event) => {
  if (!get("document-grid").contains(event.relatedTarget)) clearDropMarks();
});
document.addEventListener("dragend", clearDropMarks);
get("blocks").addEventListener("drop", (event) => {
  clearDropMarks();
  const spot = dropSpot(event.target);
  if (!spot) return;
  if (event.dataTransfer.files.length) {
    event.preventDefault();
    addNoteImages(event.dataTransfer.files, spot.afterId).catch((error) => say(error.message));
    return;
  }
  const id = event.dataTransfer.getData("application/x-ai-note-block");
  if (!id || id === spot.beforeId || id === spot.afterId) return;
  event.preventDefault();
  change({ type: "move-shared-block", id, beforeId: spot.beforeId })
    .then(() => { activeMessage = id; renderDocument(); }).catch((error) => say(error.message));
});

// Images dropped elsewhere on the page (title, empty space) land below the active message or at the end.
const noteImageFiles = (files) => [...files].filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type) ||
  /\.(png|jpe?g|webp)$/i.test(file.name));
get("document-grid").addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files") || editingMessage) return;
  if (event.target.closest("#blocks, form, #side-chat")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
get("document-grid").addEventListener("drop", (event) => {
  if (!event.dataTransfer.files.length || event.target.closest("#blocks, form, #side-chat")) return;
  event.preventDefault();
  const images = noteImageFiles(event.dataTransfer.files);
  if (!images.length) return say("笔记块只支持 PNG、JPG 或 WebP 图片；PDF 请拖到提问框作为附件。");
  addNoteImages(images, insertionPoint()).catch((error) => say(error.message));
});

// Ctrl+V: in a question box the files become attachments of that message; elsewhere in the
// document, images become note blocks below the active message (or at the end of the chat).
document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length || !state) return;
  const form = event.target.closest?.("#main-form, #side-form");
  if (form) {
    event.preventDefault();
    stageFiles(form.id === "side-form" ? "side" : "main", files).catch((error) => say(error.message));
    return;
  }
  if (activeView !== "document" || event.target.closest?.("input, textarea, [contenteditable='true']")) return;
  if (document.querySelector("dialog[open]")) return;
  const images = noteImageFiles(files);
  if (!images.length) return;
  event.preventDefault();
  addNoteImages(images, insertionPoint()).catch((error) => say(error.message));
});

// Notebook-style selection: click a message to make it active; keyboard works on the active one.
get("blocks").addEventListener("click", (event) => {
  const row = event.target.closest("#blocks > .chat-row[data-message-id]");
  if (!row || editingMessage) return;
  if (event.target.closest("button, a, input, textarea, select, summary, details, .annotation, [data-markdown-link]")) return;
  if (!window.getSelection()?.isCollapsed) return;
  // While placing an annotation, clicking a message hangs it at that message's start.
  if (annotationPick) {
    const target = messageAnchor(row.dataset.messageId);
    if (target) finishAnnotationPick(target).catch((error) => say(error.message));
    return;
  }
  selectMessage(row.dataset.messageId, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
});
document.addEventListener("keydown", (event) => {
  if (activeView !== "document" || editingMessage || editingNote || event.altKey || event.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
  const rows = messageRows();
  const ids = rows.map((row) => row.dataset.messageId);
  const index = ids.indexOf(activeMessage);
  const key = event.key;
  const run = (task) => {
    event.preventDefault();
    try {
      Promise.resolve(task()).catch((error) => say(error.message));
    } catch (error) {
      say(error.message);
    }
  };
  if (key === "Escape") {
    if (annotationPick) {
      run(stopAnnotationPick);
    } else if (selectingMessages) {
      run(() => { selectingMessages = false; selectedMessages.clear(); renderDocument(); });
    } else if (activeMessage) {
      run(() => setActiveMessage(undefined));
    }
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  // Only steer the selection once a message is active, so arrows still scroll the page otherwise.
  if (index < 0) return;
  if (["ArrowDown", "ArrowUp", "j", "k", "J", "K"].includes(key)) {
    const step = key === "ArrowDown" || key.toLowerCase() === "j" ? 1 : -1;
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + step))];
    run(() => {
      if (event.shiftKey) {
        if (!selectingMessages) {
          selectingMessages = true;
          selectedMessages.clear();
        }
        if (activeMessage) selectedMessages.add(activeMessage);
        selectedMessages.add(next);
        activeMessage = next;
        renderDocument();
        setActiveMessage(next, true);
      } else {
        setActiveMessage(next, true);
      }
    });
    return;
  }
  const lower = key.toLowerCase();
  if (lower === "a" || lower === "b") run(() => startNewNote(insertionPoint(lower === "a")));
  else if (key === "Enter") run(() => startMessageEdit(activeMessage, rows[index].querySelector(".paper-block")));
  else if (key === " " && selectingMessages) run(() => { toggleSelected(activeMessage); renderDocument(); });
  else if (key === "Delete") run(() => rows[index].querySelector('[data-action="delete-message"]')?.click());
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
    await editorSave(get("editor-text").value, get("editor-folder-row").hidden ? undefined : get("editor-folder").value);
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
  if (text) currentTurn.activity = "正在输出";
  const avatar = document.querySelector("#main-pending:not([hidden]) .is-agent .pixel-avatar");
  if (avatar) avatar.dataset.state = "typing";
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    const output = document.querySelector(".pending:not([hidden]) .pending-output");
    if (output && currentTurn) {
      const follow = window.scrollY + innerHeight >= document.documentElement.scrollHeight - 200;
      renderMarkdown(output, currentTurn.text);
      if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
    }
  });
});
api.onTool(({ requestId, tool }) => {
  if (currentTurn?.requestId !== requestId) return;
  const previous = currentTurn.tools.find((item) => item.id === tool.id);
  if (previous) Object.assign(previous, tool);
  else currentTurn.tools.push(tool);
  renderPending();
});
api.onActivity(({ requestId, text }) => {
  if (currentTurn?.requestId !== requestId) return;
  currentTurn.activity = text;
  const label = document.querySelector(".pending:not([hidden]) .pending-header p");
  if (label) label.textContent = `${currentTurn.provider} ${text}`;
  const avatar = document.querySelector("#main-pending:not([hidden]) .is-agent .pixel-avatar");
  if (avatar) avatar.dataset.state = text.includes("搜索") ? "searching" : "thinking";
});
api.onAccount(({ id, success }) => {
  if (!success) return say("登录未完成，请重试。");
  accountCache.delete(id);
  void checkAccount(id).then(refreshPanels);
  if (id === currentProfile()?.id) void refreshAccount();
});
// The next member in a group answer starts; the previous one's reply is already saved.
api.onMember(({ requestId, index, member }) => {
  if (currentTurn?.requestId !== requestId) return;
  Object.assign(currentTurn, { index, provider: member.name, avatar: member.avatar,
    profileProvider: member.provider, text: "", tools: [], activity: "" });
  renderPending();
});
api.onSaved(({ requestId, notebook }) => {
  if (currentTurn?.requestId !== requestId) return;
  currentTurn.questionSaved = true;
  if (state.id === notebook.id) {
    accept(notebook);
    if (!currentTurn.branchId) {
      const input = get("main-question");
      if (input.value.trim() === currentTurn.question) {
        input.value = "";
        renderMentionHint();
        mainDrafts.delete(notebook.id);
      }
    }
    renderDocument();
  }
  renderPending();
});
let syncingLibrary = false;
async function refreshFromStore() {
  if (!state || editingMessage || editingNote || syncingLibrary) return;
  syncingLibrary = true;
  try {
    const [next, library] = await Promise.all([api.read(), api.library()]);
    const libraryChanged = JSON.stringify(library.items) !== JSON.stringify(libraryItems) ||
      JSON.stringify(library.folders || []) !== JSON.stringify(libraryFolders);
    libraryItems = library.items;
    libraryFolders = library.folders || [];
    if (next.id !== state.id) {
      await switchNotebook(async () => ({ state: next, ...library }));
    } else if ((next.revision || 0) > (state.revision || 0)) {
      accept(next);
      if (focusMode === "branch" && !currentBranch()) closeFocus();
      if (focusMode === "note" && !state.notes.some((note) => note.id === focusedNoteId)) closeFocus();
      renderDocument();
      renderChat();
    } else if (libraryChanged) renderLibrary();
  } catch (error) { say(error.message); }
  finally { syncingLibrary = false; }
}
api.onLibraryChanged(refreshFromStore);
window.addEventListener("focus", refreshFromStore);
setInterval(refreshFromStore, 2500);
// The top bar and ribbon edit this chat's default member.
get("member-picker").addEventListener("change", (event) => {
  changeMembers({ type: "member-default", id: event.target.value }).catch((error) => say(error.message));
});
for (const field of ["model", "effort"]) {
  get(`${field}-picker`).addEventListener("change", (event) => {
    changeMembers({ type: "member-update", id: defaultMember().id, [field]: event.target.value })
      .catch((error) => say(error.message));
  });
}
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty("--ribbon-height", `${entry.target.offsetHeight}px`);
}).observe(document.querySelector(".app-header"));
const commentChats = setupCommentChats(api, {
  profile: () => {
    const member = defaultMember();
    return member && { id: member.id, name: member.name, provider: profileOf(member)?.provider };
  },
  notify: say, openFork: (target) => switchNotebook(() => api.forkComment(target))
});
const pdfReview = setupPdfReview(api, { edit: showEditor, notify: say, commentChats });

try {
  const [notebook, savedSettings, library] = await Promise.all([api.read(), api.settings(), api.library()]);
  accept(notebook);
  settings = savedSettings;
  applyAppearance();
  libraryItems = library.items;
  libraryFolders = library.folders || [];
  activeBlock = state.blocks[0]?.id;
  renderDocument();
  updateView();
  renderPending();
  await refreshAccount();
} catch (error) {
  say(error.message);
}
