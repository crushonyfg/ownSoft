const { contextBridge, ipcRenderer, webUtils } = require("electron");

function invoke(channel, value) {
  return ipcRenderer.invoke(channel, value).then((response) => {
    if (!response.ok) throw new Error(response.error);
    return response.data;
  });
}

contextBridge.exposeInMainWorld("notebook", {
  read: () => invoke("notebook:read"),
  library: () => invoke("library:read"),
  openNotebook: (id) => invoke("library:open", id),
  createNotebook: (title) => invoke("library:create", title),
  forkComment: (target) => invoke("comment:fork", target),
  sendComment: (payload) => invoke("comment:send", payload),
  change: (action) => invoke("notebook:change", action),
  settings: () => invoke("settings:read"),
  setSetting: (action) => invoke("settings:change", action),
  account: (id) => invoke("account:read", id),
  login: (id) => invoke("account:login", id),
  stageAttachments: (files, available) => invoke("attachments:stage", {
    paths: Array.from(files, (file) => webUtils.getPathForFile(file)), available
  }),
  removeAttachment: (id) => invoke("attachments:remove", id),
  openAttachment: (id) => invoke("attachments:open", id),
  openLink: (url) => invoke("notebook:open-link", url),
  openReview: (file) => invoke("review:open", webUtils.getPathForFile(file)),
  recentReview: () => invoke("review:recent"),
  restoreReview: () => invoke("review:restore"),
  visitReview: (details) => invoke("review:visit", details),
  releaseReview: (id) => invoke("review:release", id),
  saveReview: (details) => invoke("review:save", details),
  send: (message) => invoke("turn:send", message),
  stop: (id) => invoke("turn:stop", id),
  onProgress: (callback) => { ipcRenderer.on("turn:progress", (_event, data) => callback(data)); },
  onAccount: (callback) => { ipcRenderer.on("account:status", (_event, data) => callback(data)); }
});
