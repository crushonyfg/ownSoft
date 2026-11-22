// One picker for converting a message into an annotation anywhere in the chat hierarchy.
// The database validates the chosen block and quote again when the conversion is saved.
export function setupAnnotationTargets(api, { notify, onCurrent, onPdf, onMove }) {
  const get = (id) => document.getElementById(id);
  const dialog = get("annotation-target-dialog");
  const tree = get("annotation-target-tree");
  const list = get("annotation-target-messages");
  const blockPicker = get("annotation-target-block");
  const text = get("annotation-target-text");
  let source = null;
  let targets = [];
  let targetId = null;
  let message = null;
  let busy = false;
  const button = (label, className = "") => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = className;
    item.textContent = label;
    return item;
  };
  const showError = (message) => {
    const error = get("annotation-target-error");
    error.textContent = message;
    error.hidden = !message;
  };
  const attempt = (task) => Promise.resolve().then(task).catch((error) => {
    if (dialog.open) showError(error.message);
    else notify(error.message);
  });
  const kindLabel = (kind) => ({ chat: "会话", note: "批注追问", branch: "分支", thread: "私聊",
    "pdf-chat": "PDF 全文", "pdf-comment": "PDF 批注", "md-chat": "文档全文", "md-comment": "文档批注" })[kind] || "会话";

  function renderTree() {
    const query = get("annotation-target-search").value.trim().toLocaleLowerCase();
    const byId = new Map(targets.map((item) => [item.id, item]));
    const visible = new Set();
    for (const item of targets) {
      if (query && !`${item.title} ${kindLabel(item.kind)}`.toLocaleLowerCase().includes(query)) continue;
      let cursor = item;
      for (let i = 0; cursor && i < 30 && !visible.has(cursor.id); i += 1) {
        visible.add(cursor.id);
        cursor = byId.get(cursor.parentId);
      }
    }
    const children = new Map();
    for (const item of targets) {
      const key = item.parentId || "";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(item);
    }
    const visited = new Set();
    const rows = [];
    function walk(id, depth) {
      for (const item of children.get(id) || []) {
        if (!visible.has(item.id)) continue;
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        const row = button(`${kindLabel(item.kind)} · ${item.title}`, "annotation-tree-item");
        row.dataset.chatId = item.id;
        row.style.paddingLeft = `${9 + Math.min(depth, 8) * 16}px`;
        row.title = `${item.title}\n${item.id}`;
        row.setAttribute("aria-current", String(item.id === targetId));
        row.addEventListener("click", () => attempt(() => selectChat(item.id)));
        rows.push(row);
        walk(item.id, depth + 1);
      }
    }
    walk("", 0);
    for (const item of targets) if (!visited.has(item.id)) walk(item.parentId, 0);
    tree.replaceChildren(...rows);
  }

  function renderBlocks(preferredId) {
    blockPicker.replaceChildren(...(message?.blocks || []).map((block, index) => {
      const option = document.createElement("option");
      option.value = block.id;
      option.textContent = `第 ${index + 1} 段 · ${block.text.replace(/\s+/g, " ").slice(0, 55)}`;
      return option;
    }));
    blockPicker.disabled = !message;
    if (message) blockPicker.value = message.blocks.some((item) => item.id === preferredId)
      ? preferredId : message.blocks[0].id;
    const block = message?.blocks.find((item) => item.id === blockPicker.value);
    const pdf = block?.noteType === "pdf";
    text.value = block?.text || "";
    get("annotation-target-start").hidden = pdf;
    get("annotation-target-start").disabled = !message;
    const selected = get("annotation-target-selection");
    selected.textContent = pdf ? "挂到 PDF 本身" : "挂到选中文字";
    selected.disabled = !message;
    get("annotation-target-hint").hidden = !pdf;
    showError("");
  }

  async function selectChat(id) {
    targetId = id;
    message = null;
    renderBlocks();
    renderTree();
    const byId = new Map(targets.map((item) => [item.id, item]));
    const path = [];
    for (let item = byId.get(id), i = 0; item && i < 30; item = byId.get(item.parentId), i += 1) {
      path.unshift(item.title);
    }
    get("annotation-target-title").textContent = path.join(" › ") || "选择会话";
    list.textContent = "正在读取消息…";
    const messages = await api.annotationMessages(id);
    if (!dialog.open || targetId !== id) return;
    const choices = messages.filter((entry) => !(id === source.notebookId && entry.id === source.messageId));
    list.replaceChildren(...choices.map((entry) => {
      const row = button(`${entry.noteType === "pdf" ? "PDF 笔记" : entry.kind === "question" ? "你" : entry.kind === "reply" ? "成员" : "笔记"} · ${entry.preview}`,
        "annotation-message-item");
      row.dataset.messageId = entry.id;
      row.title = `消息 ID：${entry.id}`;
      row.addEventListener("click", () => attempt(() => selectMessage(id, entry.id)));
      return row;
    }));
    if (!choices.length) list.textContent = "这个会话还没有可挂靠的其他消息。";
  }

  async function selectMessage(chatId, messageId, blockId) {
    const found = await api.annotationMessage(chatId, messageId);
    if (!dialog.open || targetId !== chatId) return;
    if (chatId === source.notebookId && found.messageId === source.messageId) throw new Error("批注不能挂在它自己这条消息上。");
    message = found;
    renderBlocks(blockId);
    for (const item of list.querySelectorAll(".annotation-message-item")) {
      item.setAttribute("aria-current", String(item.dataset.messageId === found.messageId));
    }
  }

  function selectedAnchor(useSelection) {
    if (!message) throw new Error("请先选择一条消息。");
    const block = message.blocks.find((item) => item.id === blockPicker.value);
    if (!block) throw new Error("段落已改变，请重新选择。");
    if (useSelection) {
      const start = text.selectionStart;
      const end = text.selectionEnd;
      if (end <= start) throw new Error("请先在右侧原文框中选中一段文字。");
      if (end - start > 8000) throw new Error("选中文字不能超过 8000 字。");
      return { blockId: block.id, start, quote: block.text.slice(start, end) };
    }
    const start = block.text.search(/\S/);
    return { blockId: block.id, start, quote: block.text.slice(start).split(/\r?\n/, 1)[0].slice(0, 40) };
  }

  async function commit(useSelection) {
    if (busy || !source || !targetId) return;
    busy = true;
    try {
      await onMove({ source, targetId, anchor: selectedAnchor(useSelection),
        targetTitle: targets.find((item) => item.id === targetId)?.title || "目标会话" });
      dialog.close();
    } finally { busy = false; }
  }

  get("annotation-target-close").addEventListener("click", () => dialog.close());
  get("annotation-target-current").addEventListener("click", () => {
    const picked = source;
    dialog.close();
    onCurrent(picked);
  });
  get("annotation-target-pdf").addEventListener("click", () => {
    const picked = source;
    dialog.close();
    attempt(() => onPdf(picked));
  });
  get("annotation-target-find").addEventListener("click", () => attempt(async () => {
    const id = get("annotation-target-id").value.trim();
    const found = await api.resolveAnnotationMessage(id);
    await selectChat(found.notebookId);
    await selectMessage(found.notebookId, found.messageId, id);
    [...list.querySelectorAll(".annotation-message-item")]
      .find((item) => item.dataset.messageId === found.messageId)?.scrollIntoView({ block: "nearest" });
  }));
  get("annotation-target-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); get("annotation-target-find").click(); }
  });
  get("annotation-target-search").addEventListener("input", renderTree);
  blockPicker.addEventListener("change", () => {
    const block = message?.blocks.find((item) => item.id === blockPicker.value);
    const pdf = block?.noteType === "pdf";
    text.value = block?.text || "";
    get("annotation-target-start").hidden = pdf;
    get("annotation-target-selection").textContent = pdf ? "挂到 PDF 本身" : "挂到选中文字";
    get("annotation-target-hint").hidden = !pdf;
    showError("");
  });
  get("annotation-target-start").addEventListener("click", () => attempt(() => commit(false)));
  get("annotation-target-selection").addEventListener("click", () => attempt(() =>
    commit(message?.blocks.find((item) => item.id === blockPicker.value)?.noteType !== "pdf")));
  dialog.addEventListener("close", () => { source = null; message = null; });

  return {
    open: async (item) => {
      source = item;
      targetId = null;
      message = null;
      get("annotation-target-id").value = "";
      showError("");
      get("annotation-target-search").value = "";
      get("annotation-target-pdf").hidden = !item.pdfHash;
      get("annotation-target-heading").textContent = "选择批注位置";
      list.textContent = "选择左侧会话，再选择一条消息。";
      renderBlocks();
      dialog.showModal();
      targets = await api.annotationTargets();
      if (!dialog.open) return;
      renderTree();
      await selectChat(item.notebookId);
    }
  };
}
