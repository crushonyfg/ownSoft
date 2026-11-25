// Markdown documents: preview, edit the source, ask about a passage, annotate, and discuss the
// whole document. The text is saved in the app as you type; 保存到文件 writes the .md file.
import { renderMarkdown, selectionSource, sourceRange } from "./markdown-dom.mjs";
import { anchoredText, toggleTextMark } from "./text-anchors.mjs";
import { setupReviewHistory } from "./review-history.mjs";
import { shiftAnnotations, mergeDocumentDraft } from "./md-document.mjs";
import { embedChat, openingChat } from "./embedded-chat.mjs";
import { annotationCard } from "./annotation-card.mjs";
import { attachSlashLinks } from "./internal-links.mjs";

const make = (tag, className = "", text = "") => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};
const control = (text, className = "") => {
  const element = make("button", className, text);
  element.type = "button";
  return element;
};

 export function setupMdReview(api, { edit, notify, commentChats, focus, onSaved = () => {} }) {
  const get = (id) => document.getElementById(id);
  const view = get("md-view");
  const source = get("md-source");
  attachSlashLinks(source, source.parentElement, async () => {
    const [library, docs] = await Promise.all([api.library(), api.mdList()]);
    return [
      ...library.items.map(({ id, title }) => ({ id, title, kind: "chat" })),
      ...docs.map(({ id, name }) => ({ id, title: name, kind: "md" }))
    ];
  }, (error) => notify(error.message));
  const preview = get("md-preview");
  const tools = get("md-tools");
  let doc = null;
  let selection = null;
  let activeId;
  let saveTimer;
  let saving = Promise.resolve();
  let previewTimer;
  let selectionKey;
  let pendingSave = false;
  let serverBase = null;
  let previewSignature = "";
  const history = setupReviewHistory(api, { host: get("md-history"), kind: "md", current: () => doc?.id,
    toggle: get("md-history-toggle"), layout: view.querySelector(".md-layout"),
    open: (item) => showDocumentChat(item.commentId, { chatId: item.id, title: item.title }), notify });
  const attempt = (work) => Promise.resolve().then(work).catch((error) => notify(error.message));

  // ---- header and modes ---------------------------------------------------------------------
  function paintHeader() {
    view.dataset.mdId = doc?.id || "";
    get("md-name").textContent = doc?.name || "Markdown 文档";
    get("md-path").textContent = doc?.path || "（还没有对应的文件）";
    get("md-path").title = doc?.path || "";
    get("md-status").textContent = !doc ? "" : pendingSave ? "草稿尚未完成保存" : doc.unsynced ? (doc.path ? "改动已存在应用里，未写回文件" : "未保存为文件") : "已与文件一致";
    get("md-status").classList.toggle("is-unsynced", Boolean(doc?.unsynced));
    get("md-reveal").disabled = !doc?.path;
    for (const button of view.querySelectorAll("[data-md-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mdMode === doc?.mode));
    }
    view.dataset.mode = doc?.mode || "preview";
  }

  function setMode(mode) {
    if (!doc) return;
    doc.mode = mode;
    paintHeader();
    if (mode !== "source") renderPreview();
    if (mode !== "preview") source.focus();
    scheduleSave();
  }

  // ---- preview with annotation marks --------------------------------------------------------
  function marks() {
    return [...(doc.marks || []).filter((item) => !item.lost).map((item) => ({ start: item.start, end: item.start + item.quote.length, style: item.style })), ...doc.comments.filter((item) => !item.lost).map((item) => ({ start: item.start,
      end: item.start + item.quote.length, style: item.id === activeId ? "focus" : "note" }))];
  }

  function renderPreview() {
    if (!doc) return preview.replaceChildren();
    const annotations = marks();
    const signature = JSON.stringify([doc.id, doc.text, annotations]);
    if (signature === previewSignature) return;
    previewSignature = signature;
    const top = preview.scrollTop;
    renderMarkdown(preview, doc.text, { marks: annotations });
    preview.scrollTop = top;
  }

  // ---- saving --------------------------------------------------------------------------------
  function scheduleSave() {
    pendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => attempt(flush), 700);
  }

  function baseOf(value) { return structuredClone({ text: value.text, comments: value.comments, marks: value.marks || [], version: value.version }); }
  function paintSync() {
    const warning = get("md-sync-warning");
    warning.hidden = !doc?.fileConflict;
    warning.querySelector("span").textContent = doc?.fileConflict?.missing ? "原文件已不存在；应用草稿和批注仍保留。" : "磁盘文件和应用草稿有重叠改动，尚未写回文件。";
  }
  function adopt(saved, { redraw = true } = {}) {
    const beforeText = doc?.text;
    if (doc?.id === saved.id) Object.assign(doc, saved);
    else doc = saved;
    serverBase = baseOf(saved);
    pendingSave = false;
    if (source.value === beforeText || beforeText === undefined) source.value = saved.text;
    paintHeader(); paintSync();
    if (redraw) { renderPreview(); refreshComments(); }
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (!doc) return;
    pendingSave = true;
    const owner = doc;
    const snapshot = baseOf(owner);
    const base = structuredClone(serverBase || snapshot);
    const run = async () => {
      const saved = await api.mdSave({ id: owner.id, ...snapshot, base, mode: owner.mode });
      if (doc !== owner) return;
      if (JSON.stringify(snapshot) === JSON.stringify(baseOf(owner))) adopt(saved);
      else {
        const merged = mergeDocumentDraft(snapshot, baseOf(owner), saved);
        if (!merged.clean) throw new Error("保存期间同一处又有了修改。草稿仍在编辑器中，请先对照文件版本。");
        const { clean, ...content } = merged;
        const mode = owner.mode;
        adopt({ ...saved, ...content, mode, unsynced: true });
        serverBase = baseOf(saved);
        source.value = doc.text;
        scheduleSave();
      }
    };
    saving = saving.then(run, run);
    await saving;
  }
  async function refreshRemote() {
    if (!doc || pendingSave) return;
    const owner = doc;
    const next = await api.mdRefresh(owner.id);
    if (doc !== owner || pendingSave || (next.version === owner.version && JSON.stringify(next.comments) === JSON.stringify(owner.comments))) return;
    adopt(next);
  }
  api.onLibraryChanged(() => refreshRemote().catch((error) => notify(error.message)));
  window.addEventListener("focus", () => refreshRemote().catch((error) => notify(error.message)));

  async function saveToFile(saveAs = false) {
    if (!doc) return;
    await flush();
    const saved = await api.mdSave({ id: doc.id, toFile: true, saveAs });
    adopt(saved);
    onSaved();
    if (saved.fileConflict) showConflict();
    else if (!saved.unsynced) notify(`已保存到 ${saved.path}`);
  }


  // ---- editing -------------------------------------------------------------------------------
  source.addEventListener("input", () => {
    if (!doc) return;
    const before = doc.text;
    doc.text = source.value;
    doc.comments = shiftAnnotations(before, doc.text, doc.comments);
    doc.marks = shiftAnnotations(before, doc.text, doc.marks || []);
    doc.unsynced = true;
    paintHeader();
    scheduleSave();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (doc?.mode !== "source") renderPreview();
      refreshComments();
    }, 180);
  });
  // Tab indents instead of leaving the editor.
  source.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });
  // In split view the preview follows the source's scroll position.
  source.addEventListener("scroll", () => {
    if (doc?.mode !== "split") return;
    const ratio = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  });
  view.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      attempt(() => saveToFile(event.shiftKey));
    }
  });

  // ---- selection: in the preview (mapped to the source) or in the editor --------------------
  function captureSelection() {
    tools.hidden = true;
    selection = null;
    if (!doc || view.hidden) return refreshToolbar();
    if (document.activeElement === source && source.selectionEnd > source.selectionStart) {
      const start = source.selectionStart;
      selection = { start, quote: doc.text.slice(start, source.selectionEnd) };
      return refreshToolbar();
    }
    const picked = window.getSelection();
    if (!picked?.rangeCount || picked.isCollapsed) return refreshToolbar();
    const range = picked.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) return refreshToolbar();
    const mapped = selectionSource(preview, range);
    if (!mapped) return refreshToolbar();
    selection = { start: mapped.start, quote: doc.text.slice(mapped.start, mapped.end) };
    const rect = Array.from(range.getClientRects()).at(-1);
    if (rect?.height) {
      tools.hidden = false;
      tools.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tools.offsetWidth - 8))}px`;
      const above = rect.top - tools.offsetHeight - 6;
      tools.style.top = `${above > 60 ? above : rect.bottom + 6}px`;
    }
    refreshToolbar();
  }

  function refreshToolbar() {
    const usable = Boolean(selection?.quote.trim()) && selection.quote.length <= 20_000;
    get("md-ask").disabled = !usable;
    get("md-annotate").disabled = !usable;
    get("md-highlight").disabled = get("md-underline").disabled = !usable;
  }

  document.addEventListener("selectionchange", () => { if (!view.hidden) captureSelection(); });
  source.addEventListener("select", captureSelection);
  tools.addEventListener("pointerdown", (event) => event.preventDefault());
  preview.addEventListener("scroll", () => { tools.hidden = true; }, { passive: true });

  function takeSelection() {
    if (!selection?.quote.trim()) throw new Error("请先在预览或源码里选中一段文字。");
    const picked = selection;
    tools.hidden = true;
    return picked;
  }

  // ---- annotations ---------------------------------------------------------------------------
  function annotate() {
    const { start, quote } = takeSelection();
    const ownerId = doc.id, original = doc.text;
    const anchor = anchoredText(original, start, quote);
    edit({ heading: "新建批注", reference: quote.slice(0, 600), limit: 20_000, save: (text) => {
      if (!text.trim()) throw new Error("请输入批注。");
      if (doc?.id !== ownerId) throw new Error("文档已切换，请回到原文档保存这条批注。");
      const moved = shiftAnnotations(original, doc.text, [anchor])[0];
      const item = { id: crypto.randomUUID(), ...moved, originalQuote: quote, title: "我的批注", text: text.trim() };
      doc.comments.push(item);
      activeId = item.id;
      renderAll();
      scheduleSave();
    } });
  }

  function locate(item) {
    activeId = item.id;
    renderPreview();
    refreshComments();
    if (item.lost) return notify("原文已改动，找不到这条批注对应的文字。");
    if (doc.mode === "source") {
      source.focus();
      source.setSelectionRange(item.start, item.start + item.quote.length);
      const line = doc.text.slice(0, item.start).split("\n").length;
      const lines = Math.max(1, doc.text.split("\n").length);
      source.scrollTop = Math.max(0, (line / lines) * source.scrollHeight - source.clientHeight / 3);
      return;
    }
    const range = sourceRange(preview, item.start, item.start + item.quote.length);
    const target = range?.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement
      : range?.startContainer.childNodes[range.startOffset] || range?.startContainer;
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function refreshComments() {
    const list = get("md-comment-list");
    if (!doc) return list.replaceChildren();
    const items = [...doc.comments].sort((a, b) => (a.lost - b.lost) || a.start - b.start);
    get("md-count").textContent = items.length ? `${items.length} 条` : "";
    list.replaceChildren();
    if (!items.length) list.append(make("p", "review-empty-comments", "选中文字后点「批注」或「问 AI」，有用的回答可以存为批注。"));
    for (const item of items) {
      const key = `md:${doc.id}:${item.id}`;
      const card = make("article", item.id === activeId ? "review-card active" : "review-card");
      card.dataset.mdComment = item.id;
      const jump = control(item.title || "批注", "review-card-jump");
      jump.addEventListener("click", () => locate(item));
      card.append(jump);
      annotationCard(card, { key, text: item.text,
        open: () => attempt(async () => {
          await flush();
          await focus({ kind: "md-comment", docId: doc.id, itemId: item.id, title: doc.name, quote: item.quote });
        }) });
      if (item.lost) card.append(make("p", "md-lost", item.lostReason || "原文已改动，批注保留，等待重新关联"));
      card.append(make("blockquote", "review-quote", item.quote.slice(0, 400)));
      const body = make("div", "review-body markdown-content");
      renderMarkdown(body, item.text);
      card.append(body);
      const actions = make("footer");
      const revise = control("编辑");
      const remove = control("删除");
      revise.addEventListener("click", () => edit({ heading: item.title || "编辑批注", reference: item.quote.slice(0, 600),
        text: item.text, limit: 20_000, save: (value) => {
          if (!value.trim()) throw new Error("请输入批注。");
          item.text = value.trim();
          refreshComments();
          scheduleSave();
        } }));
      remove.addEventListener("click", () => {
        if (commentChats.pending(key)) return notify("请先停止这条批注的追问。");
        doc.comments = doc.comments.filter((comment) => comment.id !== item.id);
        commentChats.forget(key);
        if (activeId === item.id) activeId = undefined;
        renderAll();
        scheduleSave();
        if (chatTarget === item.id) mountDocumentChat(null);
      });
      const reattach = control("关联到所选文字");
      reattach.title = "先选中文档中的正确位置，再点此按钮";
      reattach.addEventListener("pointerdown", (event) => event.preventDefault());
      reattach.addEventListener("click", () => attempt(async () => {
        const picked = takeSelection();
        Object.assign(item, anchoredText(doc.text, picked.start, picked.quote));
        delete item.lost; delete item.lostReason;
        await flush(); renderAll();
      }));
      actions.append(revise, ...(item.lost ? [reattach] : []), remove);
      card.append(actions);
      // The follow-up is a full chat, shown in the lower part of the side panel.
      const follow = control(item.turns?.length ? `追问 · ${item.turns.length} 轮` : "追问", "review-follow");
      follow.title = "在下方以完整会话继续讨论这条批注";
      follow.addEventListener("click", () => mountDocumentChat(item.id));
      actions.prepend(follow);
      if (item.id === chatTarget) card.classList.add("is-chatting");
      list.append(card);
    }
  }

  // A click on underlined text in the preview opens its annotation.
  preview.addEventListener("click", (event) => {
    const marked = event.target.closest(".has-note, .math.has-note");
    if (!marked || !doc || !window.getSelection()?.isCollapsed) return;
    const range = document.createRange();
    range.selectNodeContents(marked);
    const spot = selectionSource(preview, range);
    if (!spot) return;
    const item = doc.comments.find((comment) => !comment.lost && comment.start < spot.end &&
      comment.start + comment.quote.length > spot.start);
    if (!item) return;
    activeId = item.id;
    renderPreview();
    refreshComments();
    get("md-comment-list").querySelector(`[data-md-comment="${item.id}"]`)?.scrollIntoView({ block: "nearest" });
  });

  // ---- asking about a passage ---------------------------------------------------------------
  function closeSelectionChat() {
    selectionKey = undefined;
    chatSelection = null;
    get("md-selection-chat").hidden = true;
  }

  async function ask() {
    const { start, quote } = takeSelection();
    selectionKey = crypto.randomUUID();
    await showDocumentChat(null, { kind: "md-selection", mdId: doc.id,
      selection: { id: selectionKey, start, quote } });
    get("md-document-conversation").scrollIntoView({ block: "nearest" });
  }

  // ---- whole-document conversation ----------------------------------------------------------
  // The lower part of the side panel is a full chat (the app's chat page embedded): the whole-document
  // conversation, or an annotation's follow-up when one is picked.
  let chatTarget = null;
  let chatSelection = null;
  let chatVersion = 0;
  get("md-chat-back").addEventListener("click", () => mountDocumentChat(null));
  function mountDocumentChat(commentId = chatTarget, selected = null) {
    showDocumentChat(commentId, selected).catch((error) => notify(error.message));
  }

  async function showDocumentChat(commentId, selected = null) {
    const version = ++chatVersion;
    chatSelection = selected;
    const pane = get("md-document-conversation");
    const cancelOpening = openingChat(pane);
    try {
    if (!doc) {
      chatTarget = null;
      return pane.replaceChildren();
    }
    const owner = doc;
    const comment = commentId ? owner.comments.find((item) => item.id === commentId) : null;
    chatTarget = comment?.id || null;
    get("md-chat-title").textContent = selected ? (selected.title || "选区对话") : comment ? `批注追问 · ${comment.title || "批注"}` : "全文对话";
    get("md-chat-back").hidden = !comment && !selected;
    get("md-chat-count").textContent = "";
    for (const card of document.querySelectorAll("[data-md-comment]")) {
      card.classList.toggle("is-chatting", card.dataset.mdComment === chatTarget);
    }
    await flush();
    const spec = selected || (comment ? { kind: "md-comment", mdId: owner.id, commentId: comment.id } : { kind: "md-chat", mdId: owner.id });
    const id = selected?.chatId || await api.childChatId(spec);
    if (owner !== doc || version !== chatVersion) return;
    embedChat(pane, id, { label: get("md-chat-title").textContent });
    try { localStorage.setItem(`ai-notebook:md-chat:${owner.id}`, JSON.stringify({ chatId: id, commentId: comment?.id, title: get("md-chat-title").textContent })); } catch {}
    void history.select(id);
    get("md-chat-full").onclick = () => api.openNotebookWindow(id).catch((error) => notify(error.message));
    } catch (error) { cancelOpening(); throw error; }
  }

  async function restoreChat() {
    const owner = doc;
    try {
      const saved = JSON.parse(localStorage.getItem(`ai-notebook:md-chat:${owner.id}`) || "null");
      if (saved?.chatId) {
        const chat = await api.read(saved.chatId);
        if (owner !== doc) return;
        if (chat.parent?.mdId === owner.id) {
          const comment = doc.comments.find((item) => item.id === chat.parent.commentId);
          return showDocumentChat(comment?.id || null, comment ? null : chat.parent.kind === "md-selection" ? saved : null);
        }
      }
    } catch {}
    if (owner === doc) mountDocumentChat(null);
  }

  function renderAll() {
    paintHeader();
    if (document.activeElement !== source && source.value !== doc?.text) source.value = doc?.text || "";
    renderPreview();
    refreshComments();
  }

  async function show(result) {
    if (!result) return false;
    if (doc && doc.id !== result.doc.id) await leave();
    if (doc?.id !== result.doc.id) {
      if (selectionKey) closeSelectionChat();
      doc = result.doc;
      serverBase = baseOf(doc);
      pendingSave = false;
      activeId = undefined;
      source.value = doc.text;
      await restoreChat();
    } else if (!pendingSave) adopt(result.doc);
    renderAll();
    paintSync();
    await history.refresh();
    if (result.notice) notify(result.notice);
    onSaved();
    return true;
  }

  // Closing saves the application draft; writing the file remains an explicit action.
  async function leave() {
    if (!doc) return;
    await flush();
  }

  function mark(style) {
    const selected = takeSelection();
    doc.marks ||= [];
    toggleTextMark(doc.text, doc.marks, selected, style);
    renderPreview();
    scheduleSave();
  }
  for (const style of ["highlight", "underline"]) for (const id of [`md-${style}`, `md-tools-${style}`]) {
    get(id).addEventListener("pointerdown", (event) => event.preventDefault());
    get(id).addEventListener("click", () => attempt(() => mark(style)));
  }
  function showConflict(keepDraft) {
    if (!doc?.fileConflict) return;
    get("md-conflict-local").value = keepDraft ?? doc.text;
    get("md-conflict-disk").value = doc.fileConflict.text;
    get("md-conflict-use-disk").disabled = Boolean(doc.fileConflict.missing);
    get("md-file-conflict").dataset.hash = doc.fileConflict.hash;
    if (!get("md-file-conflict").open) get("md-file-conflict").showModal();
  }
  get("md-conflict-open").addEventListener("click", () => showConflict());
  get("md-conflict-later").addEventListener("click", () => get("md-file-conflict").close());
  for (const [id, useDisk] of [["md-conflict-use-disk", true], ["md-conflict-save", false]]) {
    get(id).addEventListener("click", () => attempt(async () => {
      const draft = get("md-conflict-local").value;
      const saved = await api.mdResolve({ id: doc.id, hash: get("md-file-conflict").dataset.hash, text: draft, useDisk });
      source.value = saved.text;
      adopt(saved);
      if (saved.fileConflict) { showConflict(draft); notify("文件又有了新改动，请重新对照；你的合并草稿仍保留。 "); }
      else get("md-file-conflict").close();
    }));
  }
  let versionText;
  get("md-version-history").addEventListener("click", () => attempt(async () => {
    await flush();
    const items = await api.mdVersions(doc.id);
    const list = get("md-version-list"); list.replaceChildren();
    get("md-version-preview").value = ""; get("md-version-restore").disabled = true;
    for (const item of items) {
      const row = control(`${new Date(item.at).toLocaleString()} · ${item.reason} · ${item.length} 字符`);
      row.addEventListener("click", () => attempt(async () => {
        const snapshot = await api.mdVersionText(doc.id, item.seq);
        versionText = snapshot.text;
        get("md-version-preview").value = versionText;
        get("md-version-restore").disabled = false;
      })); list.append(row);
    }
    if (!items.length) list.append(make("p", "muted", "写回文件或检测到外部改动后，会在这里保留版本。"));
    get("md-file-versions").showModal();
  }));
  get("md-version-close").addEventListener("click", () => get("md-file-versions").close());
  get("md-version-restore").addEventListener("click", () => attempt(async () => {
    const before = doc.text;
    doc.text = versionText;
    doc.comments = shiftAnnotations(before, doc.text, doc.comments);
    doc.marks = shiftAnnotations(before, doc.text, doc.marks || []);
    doc.unsynced = true; source.value = doc.text;
    await flush(); renderAll(); get("md-file-versions").close();
    notify("已恢复为应用草稿，尚未覆盖磁盘文件。");
  }));

  window.addEventListener("beforeunload", (event) => {
    if (pendingSave) { event.preventDefault(); event.returnValue = false; }
  });
  get("md-save").addEventListener("click", () => attempt(() => saveToFile(false)));
  get("md-save-as").addEventListener("click", () => attempt(() => saveToFile(true)));
  get("md-reveal").addEventListener("click", () => attempt(() => api.mdReveal(doc.id)));
  get("md-ask").addEventListener("click", () => attempt(ask));
  get("md-annotate").addEventListener("click", () => attempt(annotate));
  get("md-tools-ask").addEventListener("click", () => attempt(ask));
  get("md-tools-note").addEventListener("click", () => attempt(annotate));
  get("md-selection-close").addEventListener("click", closeSelectionChat);
  for (const button of view.querySelectorAll("[data-md-mode]")) {
    button.addEventListener("click", () => setMode(button.dataset.mdMode));
  }

  return {
    current: () => doc,
    perform: (action) => action === "highlight" || action === "underline" ? mark(action) : action === "note" ? annotate() : ask(),
    locateComment: (id) => { const item = doc?.comments.find((item) => item.id === id); if (item) locate(item); },
    acceptAnnotation: (result) => {
      if (result.kind !== "md" || result.id !== doc?.id) return;
      if (!doc.comments.some((item) => item.id === result.comment.id)) doc.comments.push(result.comment);
      activeId = result.comment.id;
      renderAll();
      mountDocumentChat(result.comment.id);
    },
    open: async (id) => show(await api.mdOpen(id)),
    openFile: async () => show(await api.mdOpenFile()),
    openDropped: async (file) => show(await api.mdOpenDropped(file)),
    create: async () => show(await api.mdNew()),
    flush,
    leave,
    forget: (id) => {
      if (doc?.id === id) doc = null;
    }
  };
}
