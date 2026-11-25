import { renderMarkdown } from "./markdown-dom.mjs";
import { splitter } from "./splitter.mjs";
import { embedChat, openingChat } from "./embedded-chat.mjs";
import { setupReviewHistory } from "./review-history.mjs";
import { annotationCard } from "./annotation-card.mjs";

const get = (id) => document.getElementById(id);
const byPage = (left, right) => left.page - right.page ||
  (left.rects[0]?.[1] || 0) - (right.rects[0]?.[1] || 0);
const clamp = (value) => Math.max(0, Math.min(1, value));
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

// A PDF's review belongs to the PDF, not to a chat: opened from a note, an attachment, the sidebar or
// a file on disk, the same PDF shows the same annotations and conversation, saved as they change.
// onSaved(): a review was saved (the sidebar list and PDF note cards can update);
// onPick(): a PDF was chosen with the 打开 button (the app shows the review).
export function setupPdfReview(api, { edit, notify, commentChats, focus, onSaved = () => {}, onPick = () => {} }) {
  const view = get("pdf-view");
  const sheet = get("review-page-sheet");
  const scroll = get("review-scroll");
  const stack = get("review-page-stack");
  const textLayer = get("review-text");
  const canvas = get("review-canvas");
  const boxLayer = get("review-box-layer");
  const boxOutline = get("review-box-outline");
  const selectionChat = get("review-selection-chat");
  let pdfjs;
  let state;
  let pdf;
  // pdf.js closes a document through the task that loaded it.
  let pdfTask;
  let pageNumber = 1;
  let activeId;
  let selection;
  let pendingMessageConversion = null;
  let selectionKey;
  const history = setupReviewHistory(api, { host: get("review-history"), kind: "pdf", current: () => state?.hash,
    toggle: get("review-history-toggle"), layout: get("review-layout"),
    open: (item) => showReviewChat(true, item.commentId, { chatId: item.id, title: item.title }), notify });
  let boxDrag;
  let renderedPage;
  let dirty = false;
  let saving = false;
  let saveTimer = 0;
  let tab = "comments";
  // A PDF is being opened; the view must not lay out the previous one meanwhile.
  let opening = 0;
  let rendering;
  let textTask;
  let sequence = 0;
  let frame = 0;
  let visibleFrame = 0;
  let slots = [];
  let firstPageRatio = 1.414;
  const pageRatios = new Map();
  const previewJobs = new Map();
  let previewGeneration = 0;

  const attempt = (work) => Promise.resolve().then(work).catch((error) => notify(error.message));
  const all = () => [...(state?.comments || [])].sort(byPage);
  const remember = async () => {
    await api.visitReview({ id: state.id, page: pageNumber });
  };
  // A change to the annotations or the conversation; it is saved shortly afterwards.
  function markDirty() {
    dirty = true;
    refreshToolbar();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => attempt(save), 500);
  }

  // Annotations (top) and the whole-document conversation (bottom) are both on screen; this only
  // brings one of them into view.
  function showTab(name) {
    tab = name;
    const pane = get(name === "chat" ? "review-chat-pane" : "review-comments-pane");
    if (name === "chat") mountDocumentChat();
    pane.classList.remove("is-flash");
    void pane.offsetWidth;
    pane.classList.add("is-flash");
  }

  // The conversation about the whole PDF, in the second tab of the side panel.
  // The lower pane is a full chat (the app's chat page embedded): the whole-PDF conversation, or an
  // annotation's follow-up when one is picked. Everything the main chat can do works there.
  let chatTarget = null;
  let chatSelection = null;
  let chatVersion = 0;
  get("review-chat-back").addEventListener("click", () => mountDocumentChat(true, null, null));
  function mountDocumentChat(focus = false, commentId = chatTarget, selected = chatSelection) {
    showReviewChat(focus, commentId, selected).catch((error) => notify(error.message));
  }

  async function showReviewChat(focus, commentId, selected = null) {
    const version = ++chatVersion;
    chatSelection = selected;
    const pane = get("review-document-conversation");
    const cancelOpening = openingChat(pane);
    try {
    if (!state) {
      chatTarget = null;
      return pane.replaceChildren();
    }
    const review = state;
    const comment = commentId ? review.comments.find((item) => item.id === commentId) : null;
    chatTarget = comment?.id || null;
    get("review-chat-title").textContent = selected ? (selected.title || `第 ${selected.selection.page} 页 · 选区对话`) : comment ? `批注追问 · ${comment.title || "批注"}` : "全文对话";
    get("review-chat-back").hidden = !comment && !selected;
    get("review-chat-count").textContent = "";
    get("review-chat-hint").textContent = selected ? "只针对选区提问，使用完整会话的全部功能。" : comment
      ? "针对这条批注继续讨论：批注、它标注的原文和 PDF 会一起发给回答的成员。"
      : "和群聊成员讨论整份 PDF：PDF 正文和已有批注会一起发给回答的成员。";
    for (const card of document.querySelectorAll("[data-review-comment]")) {
      card.classList.toggle("is-chatting", card.dataset.reviewComment === chatTarget);
    }
    if (comment && dirty) await save();
    const spec = selected || (comment ? { kind: "pdf-comment", reviewId: review.id, commentId: comment.id } : { kind: "pdf-chat", reviewId: review.id });
    const id = selected?.chatId || await api.childChatId(spec);
    if (review !== state || version !== chatVersion) return;
    embedChat(pane, id, { label: get("review-chat-title").textContent });
    try { localStorage.setItem(`ai-notebook:pdf-chat:${review.hash}`, JSON.stringify({ chatId: id, commentId: comment?.id, title: get("review-chat-title").textContent })); } catch {}
    void history.select(id);
    get("review-chat-full").onclick = () => api.openNotebookWindow(id).catch((error) => notify(error.message));
    if (focus) pane.scrollIntoView({ block: "nearest" });
    } catch (error) { cancelOpening(); throw error; }
  }

  async function restoreChat() {
    const review = state;
    try {
      const saved = JSON.parse(localStorage.getItem(`ai-notebook:pdf-chat:${review.hash}`) || "null");
      if (saved?.chatId) {
        const chat = await api.read(saved.chatId);
        if (review !== state) return;
        if (chat.parent?.hash === review.hash) {
          const comment = state.comments.find((item) => item.id === chat.parent.commentId);
          return showReviewChat(false, comment?.id || null, comment ? null : chat.parent.kind === "pdf-selection" ? saved : null);
        }
      }
    } catch {}
    if (review === state) mountDocumentChat(false, null, null);
  }

  function refreshToolbar() {
    get("review-dirty").hidden = true;
    get("review-save").textContent = saving || dirty ? "正在保存…" : "已自动保存";
    get("review-save").disabled = true;
    get("review-export").hidden = get("review-popout").hidden = !state;
    get("review-page").value = pageNumber;
    get("review-prev").disabled = pageNumber <= 1;
    get("review-next").disabled = !pdf || pageNumber >= pdf.numPages;
    get("review-add").disabled = !selection || selection.rects.length > 70 || selection.quote.length > 8000;
    get("review-move-message").hidden = !pendingMessageConversion;
    get("review-move-message").disabled = !pendingMessageConversion || !selection ||
      selection.rects.length > 70 || selection.quote.length > 8000;
    get("review-ask").disabled = !selection || selection.quote.length > 20_000;
    get("review-ask-float").hidden = get("review-ask").disabled || !boxLayer.hidden;
  }

  function refreshComments() {
    const comments = all();
    const current = comments.filter((item) => item.page === pageNumber);
    get("review-count").textContent = `本页 ${current.length} 条 · 全文 ${comments.length} 条`;
    get("review-comment-prev").disabled = !comments.length;
    get("review-comment-next").disabled = !comments.length;
    const lines = get("review-lines");
    const list = get("review-comment-list");
    lines.replaceChildren();
    list.replaceChildren();
    if (!current.length) list.append(make("p", "review-empty-comments", "本页暂无批注"));
    for (const item of current) {
      const reviewId = state.id;
      const key = `pdf:${reviewId}:${item.id}`;
      const active = item.id === activeId;
      const card = make("article", active ? "review-card active" : "review-card");
      card.dataset.reviewComment = item.id;
      const jump = make("button", "review-card-jump");
      jump.type = "button";
      if (item.priority) jump.append(make("span", "review-priority", item.priority));
      jump.append(item.title || "批注");
      jump.addEventListener("click", () => attempt(() => selectComment(item, false)));
      card.append(jump);
      annotationCard(card, { key, text: item.text, open: () => attempt(async () => {
        if (dirty) await save();
        await focus({ kind: "pdf-comment", docId: state.hash, itemId: item.id, title: state.name, quote: item.quote });
      }) });
      if (item.quote) card.append(make("blockquote", "review-quote", item.quote));
      const body = make("div", "review-body markdown-content");
      renderMarkdown(body, item.text);
      card.append(body);
      const actions = make("footer");
      const revise = make("button", "", "编辑");
      const remove = make("button", "", "删除");
      const undo = item.movedFrom ? make("button", "review-undo", "↶") : null;
      revise.type = remove.type = "button";
      revise.addEventListener("click", () => edit({
        heading: item.title || "编辑批注", reference: item.quote, text: item.text, limit: 9000,
        save: (value) => {
          if (!value.trim()) throw new Error("请输入批注。");
          item.text = value.trim();
          markDirty();
          refreshComments();
        }
      }));
      remove.addEventListener("click", () => {
        if (commentChats.pending(key)) {
          notify("请先停止这条批注的追问。");
          return;
        }
        state.comments = state.comments.filter((comment) => comment.id !== item.id);
        commentChats.forget(key);
        if (active) activeId = undefined;
        markDirty();
        refreshComments();
        if (chatTarget === item.id) mountDocumentChat(false, null);
      });
      if (undo) {
        undo.type = "button";
        undo.title = "撤销转批注，恢复原消息";
        undo.setAttribute("aria-label", "撤销转批注，恢复原消息");
        undo.addEventListener("click", () => attempt(async () => {
          if (commentChats.pending(key)) throw new Error("请先停止这条批注的追问。");
          if (dirty) await save();
          await api.undoPdfMessageConversion(state.hash, item.id);
          state.comments = state.comments.filter((comment) => comment.id !== item.id);
          if (active) activeId = undefined;
          refreshComments();
          onSaved();
          notify("已恢复原消息，PDF 批注已移除。");
        }));
      }
      actions.append(revise, ...(undo ? [undo] : []), remove);
      card.append(actions);
      // The follow-up is a full chat, shown in the lower pane.
      const follow = make("button", "review-follow", item.turns?.length ? `追问 · ${item.turns.length} 轮` : "追问");
      follow.type = "button";
      follow.title = "在下方以完整会话继续讨论这条批注";
      follow.addEventListener("click", () => mountDocumentChat(true, item.id, null));
      actions.prepend(follow);
      if (item.id === chatTarget) card.classList.add("is-chatting");
      list.append(card);

      item.rects.forEach(([left, , right, bottom], index) => {
        const line = make("button", "review-underline");
        line.type = "button";
        line.dataset.reviewLine = item.id;
        line.setAttribute("aria-pressed", String(active));
        line.setAttribute("aria-label", `查看批注：${item.title || "批注"}`);
        if (index) line.tabIndex = -1;
        line.style.left = `${left * 100}%`;
        line.style.width = `${(right - left) * 100}%`;
        line.style.top = `calc(${bottom * 100}% - 3px)`;
        line.addEventListener("click", () => attempt(() => selectComment(item, true)));
        lines.append(line);
      });
    }
  }

  api.onLibraryChanged(() => {
    if (!state || dirty || saving) return;
    const owner = state;
    api.reviewState("pdf", owner.hash).then((next) => {
      if (!next || state !== owner || dirty || saving || JSON.stringify(next.comments) === JSON.stringify(state.comments)) return;
      state.comments = next.comments;
      refreshComments();
    }).catch((error) => notify(error.message));
  });

  function pageWidth(originalWidth) {
    const zoom = Number(get("review-zoom").value);
    const inset = parseFloat(getComputedStyle(scroll).paddingLeft) + parseFloat(getComputedStyle(scroll).paddingRight);
    return Math.min(Math.max(220, scroll.clientWidth - inset - 3), originalWidth * 1.45) * zoom;
  }

  function clearPreviews() {
    previewGeneration += 1;
    for (const job of previewJobs.values()) job.task?.cancel();
    previewJobs.clear();
    for (const slot of slots) slot.querySelector(":scope > canvas")?.remove();
  }

  function sizeSlots() {
    if (!pdf) return;
    const width = pageWidth((awaitedFirstPageWidth || 612));
    for (const [index, slot] of slots.entries()) {
      slot.style.height = `${Math.max(200, Math.round(width * (pageRatios.get(index + 1) || firstPageRatio)))}px`;
    }
  }

  let awaitedFirstPageWidth = 612;
  const stackTop = () => stack.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  function buildSlots() {
    clearPreviews();
    slots = Array.from({ length: pdf.numPages }, (_, index) => {
      const slot = make("div", "review-page-slot");
      slot.dataset.page = String(index + 1);
      slot.append(make("span", "page-placeholder", `第 ${index + 1} 页`));
      return slot;
    });
    stack.replaceChildren(...slots);
    sizeSlots();
    slots[pageNumber - 1]?.append(sheet);
  }

  async function renderPreview(number) {
    if (!pdf || number === pageNumber || previewJobs.has(number)) return;
    const slot = slots[number - 1];
    if (!slot || slot.querySelector(":scope > canvas")) return;
    const generation = previewGeneration;
    const document = pdf;
    const job = { task: null };
    previewJobs.set(number, job);
    try {
      const page = await document.getPage(number);
      if (generation !== previewGeneration || document !== pdf || number === pageNumber) return;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pageWidth(original.width) / original.width });
      pageRatios.set(number, original.height / original.width);
      slot.style.height = `${Math.round(viewport.height)}px`;
      const canvas = make("canvas");
      canvas.setAttribute("aria-label", `PDF 第 ${number} 页`);
      const pixelRatio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(viewport.width * pixelRatio);
      canvas.height = Math.round(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      slot.append(canvas);
      job.task = page.render({ canvas, viewport,
        transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        annotationMode: pdfjs.AnnotationMode.DISABLE });
      await job.task.promise;
    } catch (error) {
      if (!["RenderingCancelledException", "AbortException"].includes(error.name)) notify(error.message);
    } finally {
      if (previewJobs.get(number) === job) previewJobs.delete(number);
    }
  }

  function visiblePage() {
    const target = scroll.scrollTop + scroll.clientHeight * .38 - stackTop();
    let low = 0;
    let high = slots.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const slot = slots[middle];
      if (slot.offsetTop + slot.offsetHeight < target) low = middle + 1;
      else high = middle;
    }
    return Math.min(slots.length, low + 1);
  }

  function scheduleVisible() {
    if (visibleFrame || !pdf || view.hidden || !slots.length) return;
    visibleFrame = requestAnimationFrame(() => {
      visibleFrame = 0;
      const number = visiblePage();
      if (number && number !== pageNumber) attempt(() => changePage(number, undefined, false));
      for (let page = Math.max(1, number - 2); page <= Math.min(pdf.numPages, number + 2); page++) {
        if (page !== pageNumber) void renderPreview(page);
      }
      for (const [index, slot] of slots.entries()) {
        if (Math.abs(index + 1 - number) > 3) {
          slot.querySelector(":scope > canvas")?.remove();
          previewJobs.get(index + 1)?.task?.cancel();
        }
      }
    });
  }

  async function renderPage() {
    if (!pdf || view.hidden) return;
    if (selection) {
      selection = undefined;
      refreshToolbar();
    }
    renderedPage = undefined;
    const token = ++sequence;
    rendering?.cancel();
    textTask?.cancel();
    const number = pageNumber;
    const slot = slots[number - 1];
    if (!slot) return;
    slot.append(sheet);
    const page = await pdf.getPage(number);
    if (token !== sequence) return;
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pageWidth(original.width) / original.width });
    pageRatios.set(number, original.height / original.width);
    slot.style.height = `${Math.round(viewport.height)}px`;
    const pixelRatio = Math.min(devicePixelRatio || 1, 2);
    sheet.style.width = `${viewport.width}px`;
    sheet.style.height = `${viewport.height}px`;
    sheet.style.setProperty("--total-scale-factor", String(viewport.scale * page.userUnit));
    canvas.width = Math.max(1, Math.round(viewport.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(viewport.height * pixelRatio));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    textLayer.replaceChildren();
    const renderTask = page.render({
      canvas, viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      annotationMode: pdfjs.AnnotationMode.DISABLE
    });
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
    rendering = renderTask;
    textTask = layer;
    try {
      await Promise.all([renderTask.promise, layer.render()]);
      if (token === sequence) renderedPage = number;
    } catch (error) {
      if (token === sequence && !["RenderingCancelledException", "AbortException"].includes(error.name)) throw error;
    } finally {
      if (token === sequence) {
        rendering = undefined;
        textTask = undefined;
      }
    }
  }

  function scheduleRender() {
    if (frame || !pdf || view.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      attempt(async () => { await renderPage(); scheduleVisible(); });
    });
  }

  function reflowPages() {
    if (!pdf || view.hidden) return;
    clearPreviews();
    sizeSlots();
    scroll.scrollTop = (slots[pageNumber - 1]?.offsetTop || 0) + stackTop();
    scheduleRender();
  }

  async function changePage(number, selected, jump = true) {
    if (!pdf) return;
    const newPage = Math.max(1, Math.min(pdf.numPages, Number.isInteger(number) ? number : pageNumber));
    const changed = newPage !== pageNumber;
    pageNumber = newPage;
    activeId = selected;
    selection = undefined;
    if (changed) {
      setBoxMode(false);
      if (jump) {
        scroll.scrollTop = slots[newPage - 1].offsetTop + stackTop();
        get("review-comment-list").closest("aside").scrollTop = 0;
      }
    }
    refreshToolbar();
    refreshComments();
    if (changed) {
      await Promise.all([renderPage(), remember()]);
      scheduleVisible();
    }
  }

  async function selectComment(item, fromPage) {
    await changePage(item.page, item.id);
    const underline = get("review-lines").querySelector(`[data-review-line="${item.id}"]`);
    if (!fromPage && underline) underline.scrollIntoView({ block: "center", inline: "nearest" });
    const card = get("review-comment-list").querySelector(`[data-review-comment="${item.id}"]`);
    if (fromPage || card) card?.scrollIntoView({ block: "nearest" });
  }

  async function stepComment(direction) {
    const comments = all();
    const activeIndex = comments.findIndex((item) => item.id === activeId);
    const adjacent = activeIndex >= 0 ? comments[activeIndex + direction] : direction > 0
      ? comments.find((item) => item.page >= pageNumber)
      : comments.findLast((item) => item.page <= pageNumber);
    const next = adjacent || comments[direction > 0 ? 0 : comments.length - 1];
    if (next) await selectComment(next, false);
  }

  function captureSelection() {
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed || view.hidden || !boxLayer.hidden || renderedPage !== pageNumber) return;
    const range = selected.getRangeAt(0);
    if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return;
    const quote = selected.toString().trim();
    if (!quote) return;
    const area = sheet.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1).map((rect) =>
      [(rect.left - area.left) / area.width, (rect.top - area.top) / area.height,
        (rect.right - area.left) / area.width, (rect.bottom - area.top) / area.height].map(clamp))
      .filter(([x, y, r, b]) => r > x && b > y);
    if (!rects.length) return;
    selection = { page: pageNumber, quote, rects };
    const [left, top] = rects[0];
    const floating = get("review-ask-float");
    floating.style.left = `${Math.min(left * area.width, Math.max(0, area.width - 75))}px`;
    floating.style.top = `${Math.max(28, top * area.height - 4)}px`;
    refreshToolbar();
  }

  function canReplaceSelectionChat() { return true; }

  function closeSelectionChat() {
    selectionKey = undefined;
    chatSelection = null;
    selectionChat.hidden = true;
  }

  function openSelectionChat(source, screenshot) {
    selectionKey = crypto.randomUUID();
    return attempt(() => showReviewChat(true, null, { kind: "pdf-selection", reviewId: state.id,
      selection: { ...source, id: selectionKey } }));
  }

  function askText() {
    captureSelection();
    if (!selection || selection.quote.length > 20_000 || !canReplaceSelectionChat()) return;
    const { page, quote, rects } = selection;
    selection = undefined;
    window.getSelection()?.removeAllRanges();
    refreshToolbar();
    showTab("comments");
    openSelectionChat({ page, quote, rects });
  }

  function setBoxMode(enabled) {
    boxLayer.hidden = !enabled;
    boxOutline.hidden = true;
    boxDrag = undefined;
    get("review-box-mode").setAttribute("aria-pressed", String(enabled));
    if (enabled) {
      selection = undefined;
      window.getSelection()?.removeAllRanges();
    }
    refreshToolbar();
  }

  function boxPoint(event) {
    const area = boxLayer.getBoundingClientRect();
    return { x: clamp((event.clientX - area.left) / area.width), y: clamp((event.clientY - area.top) / area.height) };
  }

  function dragRect(event) {
    const { x, y } = boxPoint(event);
    return [Math.min(boxDrag.x, x), Math.min(boxDrag.y, y), Math.abs(boxDrag.x - x), Math.abs(boxDrag.y - y)];
  }

  function finishBox(event) {
    if (boxDrag?.id !== event.pointerId) return;
    const [left, top, width, height] = dragRect(event);
    boxDrag = undefined;
    boxOutline.hidden = true;
    if (width * boxLayer.clientWidth < 8 || height * boxLayer.clientHeight < 8 || renderedPage !== pageNumber) return;
    const x = left * canvas.width;
    const y = top * canvas.height;
    const w = width * canvas.width;
    const h = height * canvas.height;
    const scale = Math.min(1, 1900 / Math.max(w, h));
    const screenshot = make("canvas");
    screenshot.setAttribute("aria-label", "选中的 PDF 截图");
    screenshot.width = Math.max(1, Math.round(w * scale));
    screenshot.height = Math.max(1, Math.round(h * scale));
    screenshot.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, screenshot.width, screenshot.height);
    const image = Uint8Array.from(atob(screenshot.toDataURL().split(",")[1]), (character) => character.charCodeAt(0));
    setBoxMode(false);
    showTab("comments");
    openSelectionChat({ page: pageNumber, image, rects: [[left, top, left + width, top + height]] }, screenshot);
  }

  function newComment() {
    captureSelection();
    const anchor = selection;
    if (!anchor || anchor.rects.length > 70 || anchor.quote.length > 8000) return;
    edit({
      heading: "新建 PDF 批注", reference: anchor.quote, limit: 9000,
      save: (value) => {
        if (!value.trim()) throw new Error("请输入批注。");
        const item = { id: crypto.randomUUID(), ...anchor, title: "我的批注", text: value.trim(), priority: "" };
        state.comments.push(item);
        activeId = item.id;
        selection = undefined;
        window.getSelection()?.removeAllRanges();
        markDirty();
        showTab("comments");
        refreshComments();
      }
    });
  }

  function beginMessageConversion(request) {
    if (!state || state.hash !== request.hash) throw new Error("请先打开这条消息所属的 PDF。");
    if (chatTarget) throw new Error("请先切回 PDF 全文对话，再转为 PDF 批注。");
    pendingMessageConversion = request;
    refreshToolbar();
    notify("请在 PDF 左侧选中文字，再点「挂选中为批注」。");
  }

  async function moveMessageToSelection() {
    captureSelection();
    if (!pendingMessageConversion || !selection) throw new Error("请先在 PDF 中选中文字。");
    if (dirty) await save();
    const request = pendingMessageConversion;
    const result = await api.moveMessageToPdfAnnotation(request.notebookId, request.ids, request.hash, selection);
    state.comments.push(result.comment);
    pendingMessageConversion = null;
    activeId = result.comment.id;
    selection = undefined;
    window.getSelection()?.removeAllRanges();
    refreshToolbar();
    refreshComments();
    onSaved();
    notify("已挂到 PDF 原文；聊天中的 PDF 笔记也会显示这条批注。批注上可撤销转化。");
  }

  // source: { file } picked on disk (PDF or .aipdf), { attachmentId }, { notebookId, blockId } of a PDF
  // note, or { hash } of a PDF reviewed before.
  async function load(source) {
    const checkPending = () => {
      if (state && commentChats.pending(`pdf:${state.id}:`)) {
        throw new Error("请先完成或停止当前审阅的批注追问。");
      }
    };
    checkPending();
    const control = get("review-open");
    if (control.disabled) return;
    control.disabled = true;
    let task;
    let opened;
    try {
      if (state && dirty) {
        clearTimeout(saveTimer);
        await save();
      }
      opened = source.blockId ? await api.openBlockReview(source.notebookId, source.blockId)
        : source.attachmentId ? await api.openAttachmentReview(source.attachmentId)
        : source.hash ? await api.openSavedReview(source.hash) : await api.openReview(source.file);
      if (!opened) return;
      pdfjs ||= await import("./pdf-runtime/build/pdf.min.mjs");
      const asset = (path) => new URL(`./pdf-runtime/${path}`, location.href).href;
      pdfjs.GlobalWorkerOptions.workerSrc = asset("build/pdf.worker.min.mjs");
      task = pdfjs.getDocument({
        data: new Uint8Array(opened.pdf), isEvalSupported: false, useWorkerFetch: true,
        cMapUrl: asset("cmaps/"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts/"), wasmUrl: asset("wasm/")
      });
      const loaded = await task.promise;
      if (opened.comments.some((item) => item.page > loaded.numPages)) throw new Error("审阅批注指向了不存在的页面。");
      checkPending();
      sequence += 1;
      renderedPage = undefined;
      rendering?.cancel();
      textTask?.cancel();
      const previous = pdfTask;
      pdfTask = task;
      await previous?.destroy().catch(() => {});
      if (state) {
        await api.releaseReview(state.id);
        commentChats.forget(`pdf:${state.id}:`);
      }
      pdf = loaded;
      state = { id: opened.id, hash: opened.hash, comments: opened.comments, chat: opened.chat || [], name: opened.name };
      pendingMessageConversion = null;
      pageNumber = Math.max(1, Math.min(pdf.numPages, opened.page || 1));
      const firstPage = await pdf.getPage(1);
      const firstSize = firstPage.getViewport({ scale: 1 });
      awaitedFirstPageWidth = firstSize.width;
      firstPageRatio = firstSize.height / firstSize.width;
      pageRatios.clear();
      buildSlots();
      activeId = selection = undefined;
      closeSelectionChat();
      setBoxMode(false);
      dirty = false;
      await restoreChat();
      get("review-name").textContent = opened.name;
      get("review-name").title = opened.name;
      get("review-total").textContent = `/ ${pdf.numPages}`;
      get("review-page").max = pdf.numPages;
      get("review-layout").hidden = get("review-nav").hidden = get("review-selection-tools").hidden = get("review-save").hidden = false;
      get("review-empty").hidden = true;
      scroll.scrollTop = slots[pageNumber - 1].offsetTop + stackTop();
      get("review-comment-list").closest("aside").scrollTop = 0;
      refreshToolbar();
      refreshComments();
      await Promise.all([renderPage(), remember()]);
      scheduleVisible();
    } catch (error) {
      if (opened && opened.id !== state?.id) {
        await task?.destroy().catch(() => {});
        await api.releaseReview(opened.id);
      }
      throw error;
    } finally {
      control.disabled = false;
    }
  }

  async function save() {
    if (!dirty || saving || !state) return;
    saving = true;
    refreshToolbar();
    const review = state;
    const snapshot = JSON.stringify({ comments: review.comments, chat: review.chat });
    try {
      const result = await api.saveReview({ id: review.id, ...JSON.parse(snapshot) });
      if (result) {
        if (review === state) dirty = snapshot !== JSON.stringify({ comments: review.comments, chat: review.chat });
        if (review === state && !dirty) {
          const saved = await api.reviewState("pdf", review.hash);
          if (review === state && snapshot === JSON.stringify({ comments: review.comments, chat: review.chat })) {
            review.comments = saved.comments;
            refreshComments();
          }
        }
        onSaved(result);
      }
    } finally {
      saving = false;
      refreshToolbar();
      if (dirty) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => attempt(save), 500);
      }
    }
  }

  async function exportReview() {
    if (!state) return;
    const result = await api.saveReview({ id: state.id, comments: state.comments, chat: state.chat, saveAs: true });
    if (result?.exported) notify(`已导出为「${result.exported}」。`);
  }

  get("review-open").addEventListener("click", () => get("review-file").click());
  get("review-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    onPick();
    attempt(() => whileOpening(() => load({ file })));
  });
  get("review-prev").addEventListener("click", () => attempt(() => changePage(pageNumber - 1)));
  get("review-next").addEventListener("click", () => attempt(() => changePage(pageNumber + 1)));
  get("review-page").addEventListener("change", (event) => attempt(() => changePage(Number(event.target.value))));
  get("review-zoom").addEventListener("change", reflowPages);
  get("review-comment-prev").addEventListener("click", () => attempt(() => stepComment(-1)));
  get("review-comment-next").addEventListener("click", () => attempt(() => stepComment(1)));
  get("review-add").addEventListener("pointerdown", (event) => { captureSelection(); event.preventDefault(); });
  get("review-add").addEventListener("click", newComment);
  get("review-move-message").addEventListener("pointerdown", (event) => { captureSelection(); event.preventDefault(); });
  get("review-move-message").addEventListener("click", () => attempt(moveMessageToSelection));
  for (const id of ["review-ask", "review-ask-float"]) {
    get(id).addEventListener("pointerdown", (event) => { captureSelection(); event.preventDefault(); });
    get(id).addEventListener("click", askText);
  }
  get("review-selection-close").addEventListener("click", () => {
    if (canReplaceSelectionChat()) closeSelectionChat();
  });
  get("review-box-mode").addEventListener("click", () => {
    if (!boxLayer.hidden || canReplaceSelectionChat()) setBoxMode(boxLayer.hidden);
  });
  boxLayer.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || renderedPage !== pageNumber) return;
    boxDrag = { ...boxPoint(event), id: event.pointerId };
    boxLayer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  boxLayer.addEventListener("pointermove", (event) => {
    if (boxDrag?.id !== event.pointerId) return;
    const [left, top, width, height] = dragRect(event).map((value) => `${value * 100}%`);
    Object.assign(boxOutline.style, { left, top, width, height });
    boxOutline.hidden = false;
  });
  boxLayer.addEventListener("pointerup", (event) => {
    try { finishBox(event); } catch (error) { notify(error.message); }
  });
  boxLayer.addEventListener("lostpointercapture", (event) => {
    if (boxDrag?.id !== event.pointerId) return;
    boxDrag = undefined;
    boxOutline.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !view.hidden && !boxLayer.hidden) setBoxMode(false);
  });
  get("review-export").addEventListener("click", () => attempt(exportReview));
  splitter(get("review-split"), { target: get("review-layout"), property: "--review-side", fromEnd: true,
    min: 260, keep: 320, key: "review-side" });
  splitter(get("review-side-split"), { target: get("review-side"), property: "--review-top", axis: "y",
    min: 90, keep: 150, key: "review-top" });
  document.addEventListener("selectionchange", captureSelection);
  textLayer.addEventListener("pointerdown", () => {
    selection = undefined;
    refreshToolbar();
  });
  scroll.addEventListener("scroll", scheduleVisible, { passive: true });
  new ResizeObserver(reflowPages).observe(scroll);
  // While a PDF is being opened the view must not lay out pages for the previous one.
  async function whileOpening(task) {
    opening += 1;
    try {
      await Promise.resolve();
      await task();
      return true;
    } finally {
      opening -= 1;
    }
  }

  // After opening: show the whole-document conversation, or jump to one annotation.
  function arrive({ chat = false, commentId } = {}) {
    if (chat) mountDocumentChat(true);
    const comment = commentId && state.comments.find((item) => item.id === commentId);
    if (comment) requestAnimationFrame(() => attempt(() => selectComment(comment, false)));
  }

  // Call these before showing the review view, then await: pages are laid out once it is visible.
  return {
    locateComment: (id) => { const item = state?.comments.find((item) => item.id === id); if (item) attempt(() => selectComment(item, true)); },
    acceptAnnotation: (result) => {
      if (result.kind !== "pdf" || result.id !== state?.hash) return;
      if (!state.comments.some((item) => item.id === result.comment.id)) state.comments.push(result.comment);
      activeId = result.comment.id;
      refreshComments();
      mountDocumentChat(true, result.comment.id, null);
    },
    openAttachment: async (attachmentId, options) => {
      await whileOpening(() => load({ attachmentId }));
      arrive(options);
      return true;
    },
    openBlock: async (notebookId, blockId, options) => {
      await whileOpening(() => load({ notebookId, blockId }));
      arrive(options);
      return true;
    },
    openSaved: async (hash, options) => {
      if (state?.hash === hash) scheduleRender();
      else await whileOpening(() => load({ hash }));
      arrive(options);
      return true;
    },
    pickFile: () => get("review-file").click(),
    // Before closing the review, its last changes are saved.
    flush: async () => {
      if (!dirty) return;
      clearTimeout(saveTimer);
      await save();
    },
    current: () => state && { hash: state.hash, name: state.name },
    beginMessageConversion,
    activate: () => {
      if (opening || !state) return;
      mountDocumentChat();
      scheduleRender();
    }
  };
}
