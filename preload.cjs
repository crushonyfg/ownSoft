const { contextBridge, ipcRenderer, webUtils } = require("electron");

function invoke(channel, value) {
  return ipcRenderer.invoke(channel, value).then((response) => {
    if (!response.ok) throw new Error(response.error);
    return response.data;
  });
}

const mimeExtensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };

// Files from disk travel as paths; pasted screenshots and images dragged from other apps have no
// path, so their bytes are sent instead, under a readable name.
async function fileEntries(files) {
  return Promise.all(Array.from(files, async (file) => {
    const path = webUtils.getPathForFile(file);
    if (path) return path;
    const extension = mimeExtensions[file.type] || "";
    const stamp = new Date().toLocaleString("zh-CN", { hour12: false }).replace(/[/:]/g, "-");
    const generic = !file.name || /^image\.(png|jpe?g|webp)$/i.test(file.name);
    let name = generic ? `截图 ${stamp}${extension || ".png"}` : file.name;
    if (extension && !name.toLowerCase().endsWith(extension) && !(extension === ".jpg" && /\.jpeg$/i.test(name))) {
      name += extension;
    }
    return { name, data: new Uint8Array(await file.arrayBuffer()) };
  }));
}

contextBridge.exposeInMainWorld("notebook", {
  read: (id) => invoke("notebook:read", id),
  copyMessageId: (id) => invoke("clipboard:copy-message-id", id),
  annotationTargets: () => invoke("annotation:targets"),
  annotationMessages: (id) => invoke("annotation:messages", id),
  annotationMessage: (notebookId, messageId) => invoke("annotation:message", { notebookId, messageId }),
  resolveAnnotationMessage: (messageId) => invoke("annotation:resolve", messageId),
  structure: (op) => invoke("structure:apply", op),
  todos: () => invoke("todo:list"),
  saveTodo: (fields, id) => invoke("todo:save", { id, fields }),
  deleteTodo: (id) => invoke("todo:delete", id),
  runTodo: (id) => invoke("todo:run", id),
  onTodosChanged: (callback) => { ipcRenderer.on("todos:changed", () => callback()); },
  onTodoOpen: (callback) => { ipcRenderer.on("todos:open", (_event, id) => callback(id)); },
  saveImageEdit: (chatId, blockId, file, edit) => invoke("image:edit", { chatId, blockId, file, edit }),
  undoStructure: () => invoke("structure:undo"),
  structureLog: () => invoke("structure:log"),
  findMessage: (id) => invoke("structure:find", id),
  searchMessages: (text) => invoke("structure:search", text),
  relationsOf: (id) => invoke("structure:relations", id),
  moveMessageToChatAnnotation: (sourceId, ids, targetId, anchor) =>
    invoke("annotation:move", { sourceId, ids, targetId, anchor }),
  undoChatAnnotation: (targetId, noteId) => invoke("annotation:undo", { targetId, noteId }),
  library: () => invoke("library:read"),
  openNotebook: (id) => invoke("library:open", id),
  openNotebookWindow: (id) => invoke("window:open", id),
  openChildChat: (spec) => invoke("chat:open-child", spec),
  childChatId: (spec) => invoke("chat:child-id", spec),
  chatTree: (id) => invoke("chat:tree", id),
  createNotebook: (title, folderId) => invoke("library:create", { title, folderId }),
  renameNotebook: (id, title) => invoke("library:rename", { id, title }),
  moveNotebook: (id, folderId) => invoke("library:move", { id, folderId }),
  deleteNotebook: (id) => invoke("library:delete", id),
  createFolder: (name) => invoke("folder:create", name),
  renameFolder: (id, name) => invoke("folder:rename", { id, name }),
  deleteFolder: (id) => invoke("folder:delete", id),
  createFromMessages: (sourceId, ids) => invoke("library:create-from-messages", { sourceId, ids }),
  addNoteImages: async (notebookId, files, afterId) => invoke("note:add-images", {
    notebookId, afterId, paths: await fileEntries(files)
  }),
  addMarkdownBlock: (notebookId, mdId, afterId) => invoke("note:add-md", { notebookId, mdId, afterId }),
  moveMessageToPdfAnnotation: (notebookId, ids, hash, anchor) =>
    invoke("review:move-message", { notebookId, ids, hash, anchor }),
  undoPdfMessageConversion: (hash, commentId) => invoke("review:undo-message", { hash, commentId }),
  forkComment: (target) => invoke("comment:fork", target),
  chooseFolder: (notebookId) => invoke("notebook:choose-folder", notebookId),
  openFolder: (notebookId) => invoke("notebook:open-folder", notebookId),
  dataInfo: () => invoke("data:info"),
  backupNow: () => invoke("data:backup"),
  openDataFolder: (which) => invoke("data:open-folder", which),
  restoreBackup: (name) => invoke("data:restore", name),
  importBackup: () => invoke("data:import"),
  exportBackup: () => invoke("data:export"),
  moveData: () => invoke("data:move"),
  sendComment: (payload) => invoke("comment:send", payload),
  sendThread: (payload) => invoke("thread:send", payload),
  detachTurn: (requestId) => invoke("turn:detach", requestId),
  windowMode: () => invoke("window:mode"),
  // spec: { hash } of a reviewed PDF, { attachmentId }, or { notebookId, blockId } of a PDF note.
  openReviewWindow: (spec) => invoke("window:open-review", spec),
  focusReviewWindow: (spec) => invoke("window:focus-review", spec),
  openBlockReview: (notebookId, blockId) => invoke("review:open", { notebookId, blockId }),
  change: (action) => invoke("notebook:change", action),
  settings: () => invoke("settings:read"),
  setSetting: (action) => invoke("settings:change", action),
  account: (id) => invoke("account:read", id),
  login: (id) => invoke("account:login", id),
  accountLimits: (id) => invoke("account:limits", id),
  apps: () => invoke("apps:info"),
  changeMembers: (notebookId, action) => invoke("members:change", { notebookId, action }),
  stageAttachments: async (files, available) => invoke("attachments:stage", {
    paths: await fileEntries(files), available
  }),
  removeAttachment: (id) => invoke("attachments:remove", id),
  openAttachment: (id) => invoke("attachments:open", id),
  openLink: (url) => invoke("notebook:open-link", url),
  openReview: (file) => invoke("review:open", { path: webUtils.getPathForFile(file) }),
  openAttachmentReview: (id) => invoke("review:open", { attachmentId: id }),
  openSavedReview: (hash) => invoke("review:open", { hash }),
  reviewList: () => invoke("review:list"),
  reviewState: (kind, id) => invoke("review:state", { kind, id }),
  reviewSummary: (attachmentId) => invoke("review:summary", attachmentId),
  removeReview: (hash) => invoke("review:remove", hash),
  visitReview: (details) => invoke("review:visit", details),
  releaseReview: (id) => invoke("review:release", id),
  saveReview: (details) => invoke("review:save", details),
  send: (message) => invoke("turn:send", message),
  stop: (id) => invoke("turn:stop", id),
  mdList: () => invoke("md:list"),
  mdOpen: (id) => invoke("md:open", id),
  mdOpenFile: () => invoke("md:open-file"),
  mdOpenDropped: (file) => invoke("md:open-path", webUtils.getPathForFile(file)),
  mdNew: () => invoke("md:new"),
  mdRefresh: (id) => invoke("md:refresh", id),
  mdResolve: (resolution) => invoke("md:resolve", resolution),
  mdVersions: (id) => invoke("md:versions", id),
  mdVersionText: (id, seq) => invoke("md:version-text", { id, seq }),
  reviewHistory: (kind, id) => invoke("review:history", { kind, id }),
  mdSave: (details) => invoke("md:save", details),
  mdReveal: (id) => invoke("md:reveal", id),
  mdRemove: (id) => invoke("md:remove", id),
  onProgress: (callback) => { ipcRenderer.on("turn:progress", (_event, data) => callback(data)); },
  onActivity: (callback) => { ipcRenderer.on("turn:activity", (_event, data) => callback(data)); },
  onTool: (callback) => { ipcRenderer.on("turn:tool", (_event, data) => callback(data)); },
  onMember: (callback) => { ipcRenderer.on("turn:member", (_event, data) => callback(data)); },
  onSaved: (callback) => { ipcRenderer.on("turn:saved", (_event, data) => callback(data)); },
  onAccount: (callback) => { ipcRenderer.on("account:status", (_event, data) => callback(data)); },
  onLibraryChanged: (callback) => { ipcRenderer.on("library:changed", () => callback()); }
});
