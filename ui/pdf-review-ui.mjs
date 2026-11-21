import { renderMarkdown } from "./markdown-dom.mjs";

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

export function setupPdfReview(api, { edit, notify, commentChats }) {
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
  let pageNumber = 1;
  let activeId;
  let selection;
  let selectionKey;
  let boxDrag;
  let renderedPage;
  let recent;
  let restoreAttempted = false;
  let dirty = false;
  let saving = false;
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

  function showRecent(name) {
    recent = name;
    const item = get("recent-review");
    item.textContent = item.title = name || "";
    get("recent-review-section").hidden = !name;
  }

  const recentReady = api.recentReview().then((entry) => {
    if (!state) showRecent(entry?.name);
  }).catch((error) => notify(error.message));

  function refreshToolbar() {
    get("review-dirty").hidden = !dirty;
    get("review-save").disabled = saving || !dirty;
    get("review-page").value = pageNumber;
    get("review-prev").disabled = pageNumber <= 1;
    get("review-next").disabled = !pdf || pageNumber >= pdf.numPages;
    get("review-add").disabled = !selection || selection.rects.length > 70 || selection.quote.length > 8000;
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
      if (item.quote) card.append(make("blockquote", "review-quote", item.quote));
      const body = make("div", "review-body markdown-content");
      renderMarkdown(body, item.text);
      card.append(body);
      const actions = make("footer");
      const revise = make("button", "", "编辑");
      const remove = make("button", "", "删除");
      revise.type = remove.type = "button";
      revise.addEventListener("click", () => edit({
        heading: item.title || "编辑批注", reference: item.quote, text: item.text, limit: 9000,
        save: (value) => {
          if (!value.trim()) throw new Error("请输入批注。");
          item.text = value.trim();
          dirty = true;
          refreshToolbar();
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
        dirty = true;
        refreshToolbar();
        refreshComments();
      });
      actions.append(revise, remove);
      card.append(actions);
      commentChats.mount(card, {
        key,
        target: () => ({ reviewId, comment: item }),
        turns: () => item.turns || [],
        receive: ({ turn }) => {
          (item.turns ??= []).push(turn);
          dirty = true;
          refreshToolbar();
        }
      });
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

  function canReplaceSelectionChat() {
    if (!selectionKey || !commentChats.pending(selectionKey)) return true;
    notify("请先完成或停止当前的选区提问。");
    return false;
  }

  function closeSelectionChat() {
    if (selectionKey) commentChats.forget(selectionKey);
    selectionKey = undefined;
    selectionChat.hidden = true;
    get("review-selection-preview").replaceChildren();
    get("review-selection-conversation").replaceChildren();
  }

  function openSelectionChat(source, screenshot) {
    if (!canReplaceSelectionChat()) return;
    closeSelectionChat();
    const reviewId = state.id;
    selectionKey = `pdf:${reviewId}:selection:${crypto.randomUUID()}`;
    const turns = [];
    get("review-selection-title").textContent = `第 ${source.page} 页 · ${screenshot ? "框选截图" : "所选文字"}`;
    get("review-selection-preview").append(screenshot || make("blockquote", "review-quote", source.quote));
    const focus = commentChats.mount(get("review-selection-conversation"), {
      key: selectionKey, embedded: true,
      target: () => ({ reviewId, selection: source, history: turns }),
      turns: () => turns,
      receive: ({ turn }) => { turns.push(turn); }
    });
    selectionChat.hidden = false;
    selectionChat.scrollIntoView({ block: "nearest" });
    focus();
  }

  function askText() {
    captureSelection();
    if (!selection || selection.quote.length > 20_000 || !canReplaceSelectionChat()) return;
    const { page, quote } = selection;
    selection = undefined;
    window.getSelection()?.removeAllRanges();
    refreshToolbar();
    openSelectionChat({ page, quote });
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
    openSelectionChat({ page: pageNumber, image }, screenshot);
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
        dirty = true;
        window.getSelection()?.removeAllRanges();
        refreshToolbar();
        refreshComments();
      }
    });
  }

  async function load(file, attachmentId) {
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
      opened = attachmentId ? await api.openAttachmentReview(attachmentId) :
        file ? await api.openReview(file) : await api.restoreReview();
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
      await pdf?.destroy();
      if (state) {
        await api.releaseReview(state.id);
        commentChats.forget(`pdf:${state.id}:`);
      }
      pdf = loaded;
      state = { id: opened.id, comments: opened.comments };
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
      showRecent(opened.name);
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
    if (!dirty || saving) return;
    saving = true;
    refreshToolbar();
    const snapshot = JSON.stringify(state.comments);
    try {
      if (await api.saveReview({ id: state.id, comments: JSON.parse(snapshot) })) {
        dirty = snapshot !== JSON.stringify(state.comments);
        notify("审阅文件已保存。");
      }
    } finally {
      saving = false;
      refreshToolbar();
    }
  }

  get("review-open").addEventListener("click", () => {
    if (saving) return;
    if (!dirty || window.confirm("当前批注未保存。要放弃这些改动并打开其他文件吗？")) get("review-file").click();
  });
  get("review-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) attempt(() => load(file));
  });
  get("review-prev").addEventListener("click", () => attempt(() => changePage(pageNumber - 1)));
  get("review-next").addEventListener("click", () => attempt(() => changePage(pageNumber + 1)));
  get("review-page").addEventListener("change", (event) => attempt(() => changePage(Number(event.target.value))));
  get("review-zoom").addEventListener("change", reflowPages);
  get("review-comment-prev").addEventListener("click", () => attempt(() => stepComment(-1)));
  get("review-comment-next").addEventListener("click", () => attempt(() => stepComment(1)));
  get("review-add").addEventListener("pointerdown", (event) => { captureSelection(); event.preventDefault(); });
  get("review-add").addEventListener("click", newComment);
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
  get("review-save").addEventListener("click", () => attempt(save));
  document.addEventListener("selectionchange", captureSelection);
  textLayer.addEventListener("pointerdown", () => {
    selection = undefined;
    refreshToolbar();
  });
  scroll.addEventListener("scroll", scheduleVisible, { passive: true });
  new ResizeObserver(reflowPages).observe(scroll);
  window.addEventListener("beforeunload", (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = false;
    }
  });
  return {
    openAttachment: (id) => {
      if (dirty && !window.confirm("当前 PDF 批注未保存。要放弃改动并打开附件吗？")) return false;
      return load(null, id).then(() => true);
    },
    activate: () => {
      if (state) return scheduleRender();
      attempt(async () => {
        await recentReady;
        if (!state && recent && !restoreAttempted) {
          restoreAttempted = true;
          await load();
        }
      });
    }
  };
}
