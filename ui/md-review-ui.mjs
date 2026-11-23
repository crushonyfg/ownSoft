// Markdown documents: preview, edit the source, ask about a passage, annotate, and discuss the
// whole document. The text is saved in the app as you type; 保存到文件 writes the .md file.
import { renderMarkdown, selectionSource, sourceRange } from "./markdown-dom.mjs";
import { shiftAnnotations } from "./md-document.mjs";
import { embedChat } from "./embedded-chat.mjs";
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

 export function setupMdReview(api, { edit, notify, commentChats, onSaved = () => {} }) {
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
  const attempt = (work) => Promise.resolve().then(work).catch((error) => notify(error.message));

  // ---- header and modes ---------------------------------------------------------------------
  function paintHeader() {
    get("md-name").textContent = doc?.name || "Markdown 文档";
    get("md-path").textContent = doc?.path || "（还没有对应的文件）";
    get("md-path").title = doc?.path || "";
    get("md-status").textContent = !doc ? "" : doc.unsynced ? (doc.path ? "改动已存在应用里，未写回文件" : "未保存为文件") : "已与文件一致";
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
    return doc.comments.filter((item) => !item.lost).map((item) => ({ start: item.start,
      end: item.start + item.quote.length, style: item.id === activeId ? "focus" : "note" }));
  }

  function renderPreview() {
    if (!doc) return preview.replaceChildren();
    const top = preview.scrollTop;
    renderMarkdown(preview, doc.text, { marks: marks() });
    preview.scrollTop = top;
  }

  // ---- saving --------------------------------------------------------------------------------
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => attempt(flush), 700);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!doc) return;
    const current = doc;
    saving = saving.then(async () => {
      const saved = await api.mdSave({ id: current.id, text: current.text, comments: current.comments,
        chat: current.chat, mode: current.mode });
      if (current === doc) {
        doc.unsynced = saved.unsynced;
        doc.comments = mergeAnchors(doc.comments, saved.comments);
        paintHeader();
      }
    });
    await saving;
  }

  // The main process re-checks anchors; keep its verdict for annotations that did not change since.
  function mergeAnchors(mine, theirs) {
    const byId = new Map(theirs.map((item) => [item.id, item]));
    return mine.map((item) => (byId.get(item.id)?.lost && !item.lost && item.quote === byId.get(item.id).quote
      ? { ...item, lost: true } : item));
  }

  async function saveToFile(saveAs = false) {
    if (!doc) return;
    await flush();
    const saved = await api.mdSave({ id: doc.id, text: doc.text, comments: doc.comments, chat: doc.chat,
      mode: doc.mode, toFile: true, saveAs });
    Object.assign(doc, { path: saved.path, name: saved.name, unsynced: saved.unsynced });
    paintHeader();
    onSaved();
    if (!saved.unsynced) notify(`已保存到 ${saved.path}`);
  }

  // ---- editing -------------------------------------------------------------------------------
  source.addEventListener("input", () => {
    if (!doc) return;
    const before = doc.text;
    doc.text = source.value;
    doc.comments = shiftAnnotations(before, doc.text, doc.comments);
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
    edit({ heading: "新建批注", reference: quote.slice(0, 600), limit: 20_000, save: (text) => {
      if (!text.trim()) throw new Error("请输入批注。");
      const item = { id: crypto.randomUUID(), start, quote, title: "我的批注", text: text.trim() };
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
      if (item.lost) card.append(make("p", "md-lost", "原文已改动，找不到这段文字"));
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
      actions.append(revise, remove);
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
    if (selectionKey && commentChats.pending(selectionKey)) return notify("请先完成或停止当前的选区提问。");
    if (selectionKey) commentChats.forget(selectionKey);
    selectionKey = undefined;
    get("md-selection-chat").hidden = true;
    get("md-selection-preview").replaceChildren();
    get("md-selection-conversation").replaceChildren();
  }

  async function ask() {
    const { start, quote } = takeSelection();
    if (selectionKey && commentChats.pending(selectionKey)) return notify("请先完成或停止当前的选区提问。");
    closeSelectionChat();
    await flush();
    const owner = doc;
    const turns = [];
    selectionKey = `md:${owner.id}:selection:${crypto.randomUUID()}`;
    get("md-selection-preview").append(make("blockquote", "review-quote", quote.slice(0, 600)));
    // A useful answer can stay on the passage as an annotation, with its conversation.
    const keep = (turn) => {
      const save = control("存为批注", "comment-turn-action");
      save.title = "把这条回答作为批注挂在所选文字上，追问记录一起保留";
      save.addEventListener("click", () => {
        if (owner !== doc) return;
        const item = { id: crypto.randomUUID(), start, quote, title: `${turn.source?.memberName || "成员"} 的回答`.slice(0, 160),
          text: turn.answer.slice(0, 20_000), turns: turns.slice(0, turns.indexOf(turn) + 1) };
        doc.comments.push(item);
        activeId = item.id;
        renderAll();
        scheduleSave();
        notify("已存为批注，追问记录也一起保留。");
      });
      return [save];
    };
    const focus = commentChats.mount(get("md-selection-conversation"), {
      key: selectionKey, embedded: true, forkable: false,
      placeholder: "针对选中的这段提问；@ 成员可让多位依次回答",
      target: () => ({ mdId: owner.id, selection: { start, quote }, history: turns }),
      turns: () => turns,
      receive: ({ turn }) => { turns.push(turn); },
      turnActions: keep
    });
    get("md-selection-chat").hidden = false;
    get("md-selection-chat").scrollIntoView({ block: "nearest" });
    focus();
  }

  // ---- whole-document conversation ----------------------------------------------------------
  // The lower part of the side panel is a full chat (the app's chat page embedded): the whole-document
  // conversation, or an annotation's follow-up when one is picked.
  let chatTarget = null;
  get("md-chat-back").addEventListener("click", () => mountDocumentChat(null));
  function mountDocumentChat(commentId = chatTarget) {
    showDocumentChat(commentId).catch((error) => notify(error.message));
  }

  async function showDocumentChat(commentId) {
    const pane = get("md-document-conversation");
    if (!doc) {
      chatTarget = null;
      return pane.replaceChildren();
    }
    const owner = doc;
    const comment = commentId ? owner.comments.find((item) => item.id === commentId) : null;
    chatTarget = comment?.id || null;
    get("md-chat-title").textContent = comment ? `批注追问 · ${comment.title || "批注"}` : "全文对话";
    get("md-chat-back").hidden = !comment;
    get("md-chat-count").textContent = "";
    for (const card of document.querySelectorAll("[data-md-comment]")) {
      card.classList.toggle("is-chatting", card.dataset.mdComment === chatTarget);
    }
    await flush();
    const spec = comment ? { kind: "md-comment", mdId: owner.id, commentId: comment.id } : { kind: "md-chat", mdId: owner.id };
    const id = await api.childChatId(spec);
    if (owner !== doc) return;
    embedChat(pane, id, { label: get("md-chat-title").textContent });
    get("md-chat-full").onclick = () => api.openChildChat(spec).catch((error) => notify(error.message));
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
      activeId = undefined;
      source.value = doc.text;
      mountDocumentChat();
    }
    renderAll();
    if (result.notice) notify(result.notice);
    onSaved();
    return true;
  }

  // Before closing: save, and offer to write unsaved edits back to the original file.
  async function leave() {
    if (!doc) return;
    await flush();
    if (doc.unsynced && doc.path && window.confirm(`「${doc.name}」有改动还没写回原文件，现在保存到文件吗？\n（不保存的话，改动仍留在应用里。）`)) {
      await saveToFile();
    }
  }

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
