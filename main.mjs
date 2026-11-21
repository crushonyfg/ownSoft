import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Codex } from "./codex.mjs";
import { Claude } from "./claude.mjs";
import { Profiles } from "./profiles.mjs";
import { allAttachmentRefs, AttachmentStore } from "./attachments.mjs";
import { commentInput, mainHistory, noteOrigin, pdfCommentOrigin, turnInput } from "./notebook.mjs";
import { NotebookStore, requireText } from "./store.mjs";
import { readReviewFile, saveReviewFile, validateComments, validateTurns } from "./pdf-review.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pdfRuntime = dirname(require.resolve("pdfjs-dist/package.json"));
const entryUrl = "notebook://app/index.html";
const files = new Map([
  ["/index.html", "ui/index.html"], ["/style.css", "ui/style.css"],
  ["/app.mjs", "ui/app.mjs"], ["/notebook.mjs", "notebook.mjs"], ["/markdown-dom.mjs", "ui/markdown-dom.mjs"],
  ["/pdf-review-ui.mjs", "ui/pdf-review-ui.mjs"], ["/workspace.css", "ui/workspace.css"],
  ["/comment-chat.mjs", "ui/comment-chat.mjs"]
]);
protocol.registerSchemesAsPrivileged([
  { scheme: "notebook", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const override = process.env.AI_NOTEBOOK_DATA_DIR;
app.setName("AI Notebook");
if (override) {
  mkdirSync(override, { recursive: true });
  app.setPath("userData", override);
}
let window;
let store;
let profiles;
let attachments;
let local;
let activeTurn;
const reviews = new Map();
const sessions = new Map();

function handle(name, operation) {
  ipcMain.handle(name, async (event, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== entryUrl) {
      return { ok: false, error: "请求来源无效。" };
    }
    try {
      return { ok: true, data: await operation(payload) };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });
}

function notify(event, value) {
  if (window && !window.isDestroyed()) window.webContents.send(event, value);
}

function session(profile) {
  if (sessions.has(profile.id)) return sessions.get(profile.id);
  const directory = profile.native ? undefined : join(local, "profiles", profile.id);
  if (directory) mkdirSync(directory, { recursive: true });
  const work = join(local, "model-work");
  mkdirSync(work, { recursive: true });
  const client = profile.provider === "gpt" ? new Codex(work, directory) : new Claude(work, directory);
  if (profile.provider === "gpt") {
    client.on("account/login/completed", ({ success }) => {
      notify("account:status", { id: profile.id, success });
    });
  }
  sessions.set(profile.id, client);
  return client;
}

const storedAttachments = () => store.readAll().flatMap(allAttachmentRefs);

function openReview(id) {
  const review = reviews.get(id);
  if (!review) throw new Error("请先打开对应的 PDF 审阅文件。");
  return review;
}

async function loadReview(sourcePath, page = 1) {
  const opened = await readReviewFile(sourcePath).catch((error) => {
    if (error.code === "ENOENT") throw new Error("找不到上次的 PDF 文件，请点「打开」重新选择。");
    throw error;
  });
  const id = randomUUID();
  reviews.set(id, { ...opened, sourcePath, page });
  return { id, name: opened.name, pdf: opened.pdf, comments: opened.comments, page };
}

function reviewSelectionTarget({ reviewId, selection, history }) {
  const review = openReview(reviewId);
  const { page, quote, image } = selection;
  if (!Number.isInteger(page) || page < 1 || (image !== undefined && !ArrayBuffer.isView(image))) {
    throw new Error("PDF 选区无效，请重新选择。");
  }
  const reference = `${review.name} · 第 ${page} 页`;
  return {
    origin: { kind: "selection", reference, quote: image ? "" : requireText(quote, 20_000).trim(),
      text: image ? "框选内容见随附截图。" : "" },
    turns: validateTurns(history),
    screenshot: image ? { bytes: image, name: `${reference} · 框选截图` } : undefined
  };
}

async function modelReply(profile, input, controller, requestId) {
  const effort = profile.efforts[profile.model];
  const answer = await session(profile).answer(input, {
    signal: controller.signal,
    model: profile.model,
    effort,
    update: (value) => notify("turn:progress", { requestId, text: value })
  });
  controller.signal.throwIfAborted();
  return { answer, source: { provider: profile.provider, model: profile.model, effort } };
}

async function generate({ requestId, branchId, question, profileId, attachmentIds, notebookId }) {
  if (activeTurn) throw new Error("已有回答正在生成。");
  requireText(requestId, 100);
  const files = attachments.pending(attachmentIds);
  const text = requireText(question || (files.length ? "请概述附件的主要内容。" : ""), 10_000).trim();
  const notebook = store.read(notebookId);
  const profile = profiles.get(profileId);
  const branch = branchId ? notebook.branches.find((item) => item.id === branchId) : null;
  if (branchId && !branch) throw new Error("这条分支已被删除。");
  const controller = new AbortController();
  activeTurn = { requestId, branchId, controller, files, notebookId: notebook.id };
  let prepared;
  try {
    const input = turnInput(notebook, branch, text);
    const earlier = branch ? branch.turns.flatMap((turn) => turn.attachments || [])
      : mainHistory(notebook).flatMap((turn) => turn.attachments);
    prepared = await attachments.prepare([...earlier, ...files], controller.signal);
    const { answer, source } = await modelReply(profile,
      { ...input, documents: prepared.documents, images: prepared.images }, controller, requestId);
    const saved = store.saveReply(branchId, text, answer, source, files, notebook.id);
    attachments.commit(files);
    return saved;
  } finally {
    await prepared?.dispose();
    activeTurn = undefined;
  }
}

function commentTarget({ reviewId, comment, notebookId, noteId }) {
  if (reviewId) {
    const review = openReview(reviewId);
    const [checked] = validateComments([comment]);
    return { origin: pdfCommentOrigin(review.name, checked), turns: checked.turns || [] };
  }
  const notebook = store.read(notebookId);
  const note = notebook.notes.find((item) => item.id === noteId);
  if (!note) throw new Error("这条批注已不存在。");
  return { origin: noteOrigin(notebook, note), turns: note.turns || [], notebookId: notebook.id, noteId };
}

async function generateComment(payload) {
  if (activeTurn) throw new Error("已有回答正在生成。");
  const { requestId, profileId } = payload;
  requireText(requestId, 100);
  const question = requireText(payload.question, 10_000).trim();
  const target = payload.selection ? reviewSelectionTarget(payload) : commentTarget(payload);
  if (payload.reviewId && target.turns.length >= 200) {
    throw new Error(payload.selection ? "选区问答已达到上限，请重新选择内容开始提问。" : "请新开分支继续这条对话。");
  }
  const profile = profiles.get(profileId);
  const controller = new AbortController();
  activeTurn = { requestId, controller, files: [], notebookId: target.notebookId, noteId: target.noteId };
  let prepared;
  try {
    if (target.screenshot) prepared = await attachments.prepare([], controller.signal, target.screenshot);
    const input = commentInput(target.origin, target.turns, question);
    if (prepared) input.images = prepared.images;
    const reply = await modelReply(profile, input, controller, requestId);
    const turn = { id: randomUUID(), question, ...reply };
    const notebook = target.noteId ? store.saveNoteReply(target.notebookId, target.noteId, turn) : undefined;
    return { turn, notebook };
  } finally {
    await prepared?.dispose();
    activeTurn = undefined;
  }
}

function createWindow() {
  window = new BrowserWindow({
    title: "AI 笔记本",
    width: 1360, height: 930, minWidth: 730, minHeight: 540, show: false,
    icon: join(base, "notebook.ico"),
    autoHideMenuBar: true,
    webPreferences: { preload: join(base, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => {
    const answer = dialog.showMessageBoxSync(window, {
      type: "question", message: "PDF 批注有未保存的改动。",
      buttons: ["继续编辑", "放弃改动并关闭"], defaultId: 0, cancelId: 0
    });
    if (answer === 1) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { window = undefined; });
  window.loadURL(entryUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    const markdownModule = (await build({
      entryPoints: [join(base, "markdown.mjs")], bundle: true, platform: "browser", format: "esm",
      write: false, logLevel: "silent"
    })).outputFiles[0].text;
    protocol.handle("notebook", ({ url }) => {
      const { hostname, pathname } = new URL(url);
      if (hostname === "app" && pathname === "/markdown.mjs") {
        return new Response(markdownModule, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      }
      if (hostname === "app" && pathname.startsWith("/pdf-runtime/")) {
        const asset = pathname.slice("/pdf-runtime/".length);
        if (/^build\/pdf(?:\.worker)?\.min\.mjs$/.test(asset) ||
            /^(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+\.(?:bcmap|pfb|ttf|wasm|js)$/.test(asset)) {
          return net.fetch(pathToFileURL(join(pdfRuntime, asset)).href);
        }
      }
      const file = hostname === "app" && files.get(pathname);
      return file ? net.fetch(pathToFileURL(join(base, file)).href) : new Response(null, { status: 404 });
    });
    local = app.getPath("userData");
    store = new NotebookStore(join(local, "notebook.sqlite"));
    profiles = new Profiles(store.db);
    attachments = new AttachmentStore(join(local, "attachments"), join(local, "attachment-work"));
    await attachments.initialize(storedAttachments());
    handle("notebook:read", () => store.read());
    handle("library:read", () => store.library());
    handle("library:open", (id) => store.open(id));
    handle("library:create", (title) => store.create(title));
    handle("comment:fork", (payload) => {
      const { origin, turns } = commentTarget(payload);
      const label = (origin.kind === "pdf" ? origin.title : origin.text).trim().split(/\r?\n/, 1)[0].slice(0, 44);
      return store.create(`批注分支 · ${label || "追问"}`, { origin, turns });
    });
    handle("comment:send", generateComment);
    handle("notebook:change", async (action) => {
      if (action?.type === "delete-branch" && activeTurn?.branchId === action.id) {
        throw new Error("请先停止生成，再删除对话。");
      }
      if (action?.type === "delete-note" && activeTurn?.noteId === action.id) {
        throw new Error("请先停止这条批注的追问。");
      }
      if (!["delete-branch", "edit-document"].includes(action?.type)) return store.change(action, action.notebookId);
      const before = allAttachmentRefs(store.read(action.notebookId));
      const next = store.change(action, action.notebookId);
      await attachments.deleteSaved(before, storedAttachments());
      return next;
    });
    handle("attachments:stage", ({ paths, available }) => attachments.stage(paths, available));
    handle("attachments:remove", (id) => {
      if (activeTurn?.files.some((ref) => ref.id === id)) throw new Error("附件正在发送，请先停止生成。");
      return attachments.remove(id);
    });
    handle("attachments:open", async (id) => {
      const ref = storedAttachments().find((item) => item.id === id);
      if (!ref) throw new Error("附件已不存在。");
      const error = await shell.openPath(attachments.path(ref));
      if (error) throw new Error(`无法打开「${ref.name}」。`);
    });
    handle("review:open", (path) => loadReview(path));
    handle("review:recent", () => {
      const recent = store.recentReview();
      return recent && { name: recent.name, page: recent.page };
    });
    handle("review:restore", () => {
      const recent = store.recentReview();
      return recent && loadReview(recent.path, recent.page);
    });
    handle("review:visit", ({ id, page }) => {
      const review = openReview(id);
      if (!Number.isInteger(page) || page < 1) throw new Error("页码无效。");
      review.page = page;
      store.rememberReview(review.sourcePath, review.name, page);
    });
    handle("review:release", (id) => { reviews.delete(id); });
    handle("review:save", async ({ id, comments, saveAs }) => {
      const current = reviews.get(id);
      if (!current) throw new Error("当前审阅文件已经切换。");
      let path = current.path;
      if (!path || saveAs) {
        const choice = await dialog.showSaveDialog(window, {
          title: "保存 PDF 审阅文件",
          defaultPath: path || `${basename(current.name, extname(current.name))}.aipdf`,
          filters: [{ name: "AI 笔记 PDF 审阅", extensions: ["aipdf"] }]
        });
        if (choice.canceled || !choice.filePath) return false;
        path = extname(choice.filePath) ? choice.filePath : choice.filePath + ".aipdf";
      }
      await saveReviewFile(path, current.pdf, current.name, comments);
      current.path = current.sourcePath = path;
      store.rememberReview(path, current.name, current.page);
      return true;
    });
    handle("notebook:open-link", async (address) => {
      const url = new URL(address);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("链接地址无效。");
      }
      await shell.openExternal(url.href);
    });
    handle("settings:read", () => profiles.read());
    handle("settings:change", (action) => profiles.change(action));
    handle("account:read", async (id) => {
      const profile = profiles.get(id);
      const client = session(profile);
      const account = await client.account();
      const models = account.signedIn ? await client.models() : [];
      return { ...account, models };
    });
    handle("account:login", async (id) => {
      const profile = profiles.get(id);
      const client = session(profile);
      if (profile.provider === "claude") {
        await client.login();
        notify("account:status", { id: profile.id, success: true });
        return;
      }
      const { authUrl } = await client.login();
      const url = new URL(authUrl);
      if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) {
        throw new Error("无法打开 Codex 的登录页面。");
      }
      await shell.openExternal(url.href);
    });
    handle("turn:send", generate);
    handle("turn:stop", (id) => {
      if (activeTurn?.requestId === id) activeTurn.controller.abort(new Error("已停止生成。"));
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    activeTurn?.controller.abort(new Error("应用已关闭。"));
    for (const client of sessions.values()) client.close?.();
    store?.close();
  });
}
