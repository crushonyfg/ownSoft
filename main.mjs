import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Codex } from "./codex.mjs";
import { Claude } from "./claude.mjs";
import { Profiles, providerAvatar } from "./profiles.mjs";
import { appsInfo } from "./apps.mjs";
import { Antigravity } from "./antigravity.mjs";
import { allAttachmentRefs, AttachmentStore } from "./attachments.mjs";
import { commentInput, mainHistory, noteOrigin, stripSpeaker, pdfCommentOrigin, sharedNoteBlocks, turnInput } from "./notebook.mjs";
import { NotebookStore, requireText } from "./store.mjs";
import { readReviewFile, saveReviewFile, validateComments, validateTurns } from "./pdf-review.mjs";
import {
  Backups, checkDatabase, copyData, dataInfo, exportArchive, finishPendingCopy, hasDatabase, importArchive, replaceDatabase,
  resolveDataDir, saveLocation
} from "./datastore.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pdfRuntime = dirname(require.resolve("pdfjs-dist/package.json"));
const entryUrl = "notebook://app/index.html";
const files = new Map([
  ["/index.html", "ui/index.html"], ["/style.css", "ui/style.css"],
  ["/app.mjs", "ui/app.mjs"], ["/notebook.mjs", "notebook.mjs"], ["/markdown-dom.mjs", "ui/markdown-dom.mjs"],
  ["/pdf-review-ui.mjs", "ui/pdf-review-ui.mjs"], ["/workspace.css", "ui/workspace.css"],
  ["/comment-chat.mjs", "ui/comment-chat.mjs"], ["/pixel-avatars.mjs", "ui/pixel-avatars.mjs"]
]);
protocol.registerSchemesAsPrivileged([
  { scheme: "notebook", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const override = process.env.AI_NOTEBOOK_DATA_DIR;
app.setName("AI Notebook");
// Matches the Start Menu shortcut so a taskbar pin and the running window share one button.
if (process.platform === "win32") app.setAppUserModelId("AI.Notebook");
if (override) {
  mkdirSync(override, { recursive: true });
  app.setPath("userData", override);
}
let window;
let store;
let profiles;
let attachments;
let local;
let dataSource;
let backups;
let backupTimer;
let activeTurn;
const autoBackupInterval = 6 * 60 * 60 * 1000;
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

async function approveCodex(method, params) {
  const permissions = method === "item/permissions/requestApproval";
  const fallback = permissions ? { permissions: {}, scope: "turn" } : { decision: "decline" };
  if (!window || window.isDestroyed()) return fallback;
  const network = params.networkApprovalContext;
  const message = permissions ? "允许模型获取额外权限？" : network ? "允许模型访问网络地址？" :
    method === "item/fileChange/requestApproval" ? "允许模型修改文件？" : "允许模型运行命令？";
  const details = [
    params.reason,
    network && `${network.protocol || ""}://${network.host || ""}`,
    params.command,
    params.grantRoot,
    permissions && JSON.stringify(params.permissions)
  ].filter(Boolean).join("\n\n").slice(0, 6000);
  const { response } = await dialog.showMessageBox(window, {
    type: "question", title: "模型工具权限", message, detail: details,
    buttons: ["拒绝", "允许本次"], defaultId: 0, cancelId: 0, noLink: true
  });
  if (response !== 1) return fallback;
  if (permissions) {
    const requested = params.permissions || {};
    return { permissions: Object.fromEntries(Object.entries(requested).filter(([, value]) => value)), scope: "turn" };
  }
  return { decision: "accept" };
}

function session(profile) {
  if (sessions.has(profile.id)) return sessions.get(profile.id);
  const directory = profile.native ? undefined : join(local, "profiles", profile.id);
  if (directory) mkdirSync(directory, { recursive: true });
  const work = join(local, "model-work");
  mkdirSync(work, { recursive: true });
  const client = profile.provider === "gpt" ? new Codex(work, directory, approveCodex)
    : profile.provider === "gemini" ? new Antigravity(work) : new Claude(work, directory);
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

// The folder a chat's model works in: the one picked for this notebook, else the app's own.
function workingFolder(notebook) {
  if (!notebook?.workDir) return undefined;
  const ok = existsSync(notebook.workDir) && statSync(notebook.workDir).isDirectory();
  if (!ok) throw new Error(`工作文件夹「${notebook.workDir}」不存在，请重新选择或清除。`);
  return notebook.workDir;
}

const providerLabels = { gpt: "GPT", claude: "Claude", gemini: "Gemini" };

// A chat's members: its own roster once set up, else the app's default roster.
function roster(notebook) {
  if (notebook?.members?.length) return { members: notebook.members, defaultMember: notebook.defaultMember };
  const settings = profiles.read();
  return { members: settings.members, defaultMember: settings.defaultMember };
}

function lookup(group, id) {
  const member = group.members.find((item) => item.id === (id || group.defaultMember)) ?? (id ? null : group.members[0]);
  if (!member) throw new Error(id ? "提到的成员已被删除，请重新 @。" : "还没有群聊成员，请先在「成员」里添加。");
  const profile = profiles.read().profiles.find((item) => item.id === member.profileId);
  if (!profile) throw new Error(`成员「${member.name}」的账户已被删除，请在成员设置里换一个账户。`);
  return { member, profile, group };
}

// Who else is in the group, so a member knows it is one voice among several, plus its role prompt.
function persona(member, profile, group, round = []) {
  const others = group.members.filter((item) => item.id !== member.id).map((item) => item.name);
  return { name: member.name, provider: providerLabels[profile.provider] || profile.provider, others, round,
    role: member.prompt || "" };
}


async function modelReply({ member, profile, group }, input, controller, requestId, cwd, round = []) {
  const effort = member.effort || "";
  const tools = [];
  let counts;
  const raw = await session(profile).answer({ ...input, persona: persona(member, profile, group, round) }, {
    signal: controller.signal,
    cwd,
    model: member.model,
    effort,
    update: (value) => notify("turn:progress", { requestId, text: value }),
    activity: (value) => notify("turn:activity", { requestId, text: value }),
    usage: (value) => { counts = value; },
    limits: (items) => profiles.recordLimits(profile.id, items),
    tool: (item) => {
      if (!item?.id) return;
      const id = String(item.id).slice(0, 200);
      const previous = tools.find((entry) => entry.id === id);
      const entry = { id,
        title: String(item.title || previous?.title || "工具调用").slice(0, 100),
        detail: String(item.detail || previous?.detail || "").slice(0, 1200),
        status: ["running", "done", "failed"].includes(item.status) ? item.status : "running" };
      if (previous) Object.assign(previous, entry);
      else if (tools.length < 80) tools.push(entry);
      notify("turn:tool", { requestId, tool: entry });
    }
  });
  controller.signal.throwIfAborted();
  const answer = stripSpeaker(raw, member.name);
  profiles.recordUsage(member.id, counts, new Date(), profile.id);
  for (const item of tools) if (item.status === "running") item.status = "done";
  const source = { provider: profile.provider, model: member.model, effort,
    memberId: member.id, memberName: member.name, avatar: member.avatar };
  return { answer, source, tools };
}

const publicMember = ({ member, profile }) => ({
  id: member.id, name: member.name, avatar: member.avatar, provider: profile.provider
});

// Members named in the question answer one after another; without a mention the default member does.
function speakers(notebook, memberIds, single) {
  const ids = Array.isArray(memberIds) ? [...new Set(memberIds.filter((id) => typeof id === "string"))] : [];
  if (ids.length > 8) throw new Error("一次最多 @ 8 位成员。");
  const group = roster(notebook);
  const chosen = ids.length ? ids.map((id) => lookup(group, id)) : [lookup(group)];
  return single ? chosen.slice(0, 1) : chosen;
}

async function generate({ requestId, branchId, question, memberIds, attachmentIds, notebookId }) {
  if (activeTurn) throw new Error("已有回答正在生成。");
  requireText(requestId, 100);
  const files = attachments.pending(attachmentIds);
  const text = requireText(question || (files.length ? "请概述附件的主要内容。" : ""), 10_000).trim();
  const first = store.read(notebookId);
  const branch = branchId ? first.branches.find((item) => item.id === branchId) : null;
  if (branchId && !branch) throw new Error("这条分支已被删除。");
  const queue = speakers(first, memberIds, Boolean(branchId));
  const cwd = workingFolder(first);
  const controller = new AbortController();
  activeTurn = { requestId, branchId, controller, files, notebookId: first.id };
  let saved = first;
  try {
    for (const [index, speaker] of queue.entries()) {
      controller.signal.throwIfAborted();
      notify("turn:member", { requestId, index, total: queue.length, member: publicMember(speaker) });
      const notebook = store.read(first.id);
      const input = turnInput(notebook, branch, text);
      // Later speakers see the question once, plus what the earlier members just said.
      // The last history entry is this question with their labelled answers, e.g. 【gpt1】….
      if (index > 0) {
        const history = mainHistory(notebook);
        input.history = history.slice(0, -1).map(({ question: asked, answer }) => ({ question: asked, answer }));
        input.peers = history.at(-1)?.answer || "";
      }
      const earlier = branch ? branch.turns.flatMap((turn) => turn.attachments || [])
        : mainHistory(notebook).flatMap((turn) => turn.attachments);
      const sharedImages = sharedNoteBlocks(notebook).flatMap((block) => block.attachments || []);
      const prepared = await attachments.prepare([...sharedImages, ...earlier, ...(index ? [] : files)], controller.signal);
      try {
        const { answer, source, tools } = await modelReply(speaker,
          { ...input, documents: prepared.documents, images: prepared.images }, controller, requestId, cwd,
          queue.map(({ member }) => member.name));
        saved = store.saveReply(branchId, text, answer, source, index ? [] : files, first.id, tools,
          { continueTurn: index > 0 });
        if (!index) attachments.commit(files);
        if (index < queue.length - 1) notify("turn:saved", { requestId, notebook: saved });
      } catch (error) {
        if (index > 0 && !controller.signal.aborted) {
          throw new Error(`${speaker.member.name}：${error.message}（前面成员的回答已保存）`);
        }
        throw error;
      } finally {
        await prepared.dispose();
      }
    }
    return saved;
  } finally {
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
  const { requestId, memberId } = payload;
  requireText(requestId, 100);
  const question = requireText(payload.question, 10_000).trim();
  const target = payload.selection ? reviewSelectionTarget(payload) : commentTarget(payload);
  if (payload.reviewId && target.turns.length >= 200) {
    throw new Error(payload.selection ? "选区问答已达到上限，请重新选择内容开始提问。" : "请新开分支继续这条对话。");
  }
  const owner = target.notebookId ? store.read(target.notebookId) : null;
  const speaker = lookup(roster(owner), memberId);
  const cwd = owner ? workingFolder(owner) : undefined;
  const controller = new AbortController();
  activeTurn = { requestId, controller, files: [], notebookId: target.notebookId, noteId: target.noteId };
  let prepared;
  try {
    if (target.screenshot) prepared = await attachments.prepare([], controller.signal, target.screenshot);
    const input = commentInput(target.origin, target.turns, question);
    if (prepared) input.images = prepared.images;
    const reply = await modelReply(speaker, input, controller, requestId, cwd);
    const turn = { id: randomUUID(), question, ...reply };
    const notebook = target.noteId ? store.saveNoteReply(target.notebookId, target.noteId, turn) : undefined;
    return { turn, notebook };
  } finally {
    await prepared?.dispose();
    activeTurn = undefined;
  }
}

function autoBackup() {
  try {
    backups?.autoIfChanged();
  } catch (error) {
    console.error("Automatic backup failed:", error);
  }
}

function shutDown() {
  clearInterval(backupTimer);
  activeTurn?.controller.abort(new Error("应用已关闭。"));
  for (const client of sessions.values()) client.close?.();
  sessions.clear();
  store?.close();
  store = undefined;
}

// Database swaps happen with everything closed, then the app starts again on the new data.
function restartWith(task) {
  shutDown();
  try {
    task?.();
  } finally {
    app.relaunch();
    app.exit(0);
  }
}

function requireIdle() {
  if (activeTurn) throw new Error("请先等待或停止正在生成的回答。");
}

async function confirm(message, detail, action) {
  const { response } = await dialog.showMessageBox(window, {
    type: "warning", title: "数据管理", message, detail, buttons: ["取消", action], defaultId: 0, cancelId: 0, noLink: true
  });
  return response === 1;
}

const sizeLabel = (bytes) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function restoreFrom(file, label) {
  requireIdle();
  const count = checkDatabase(file);
  const ok = await confirm(`用「${label}」替换当前笔记？`,
    `这份备份里有 ${count} 本笔记。替换前会先把当前数据另存为一份「恢复前」备份，之后应用会自动重启。`, "恢复并重启");
  if (!ok) return false;
  backups.create("before-restore");
  restartWith(() => replaceDatabase(local, file));
  return true;
}

function setupDataHandlers() {
  handle("data:info", () => ({ ...dataInfo(local, store.db, backups), source: dataSource }));
  handle("data:backup", () => {
    backups.create("manual");
    return { ...dataInfo(local, store.db, backups), source: dataSource };
  });
  handle("data:open-folder", async (which) => {
    const error = await shell.openPath(which === "backups" ? join(local, "backups") : local);
    if (error) throw new Error("无法打开文件夹。");
  });
  handle("data:restore", (name) => restoreFrom(backups.path(name), name));
  handle("data:import", async () => {
    const choice = await dialog.showOpenDialog(window, {
      title: "从备份恢复", properties: ["openFile"],
      filters: [{ name: "AI 笔记本备份", extensions: ["zip", "sqlite"] }]
    });
    if (choice.canceled || !choice.filePaths[0]) return false;
    const file = choice.filePaths[0];
    if (extname(file).toLowerCase() !== ".zip") return restoreFrom(file, basename(file));
    const temp = importArchive(file, local);
    try {
      return await restoreFrom(temp, basename(file));
    } finally {
      if (store) rmSync(temp, { force: true });
    }
  });
  handle("data:export", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const choice = await dialog.showSaveDialog(window, {
      title: "导出完整备份", defaultPath: `AI笔记本备份-${day}.zip`,
      filters: [{ name: "AI 笔记本备份", extensions: ["zip"] }]
    });
    if (choice.canceled || !choice.filePath) return null;
    const file = extname(choice.filePath) ? choice.filePath : `${choice.filePath}.zip`;
    exportArchive(store.db, local, file);
    return { file, size: sizeLabel(statSync(file).size) };
  });
  handle("data:move", async () => {
    requireIdle();
    if (dataSource === "env") throw new Error("数据位置由环境变量 AI_NOTEBOOK_DATA_DIR 指定，请先移除该变量。");
    const choice = await dialog.showOpenDialog(window, {
      title: "选择新的数据文件夹", properties: ["openDirectory", "createDirectory"]
    });
    if (choice.canceled || !choice.filePaths[0]) return false;
    const target = choice.filePaths[0];
    if (target.toLowerCase() === local.toLowerCase()) return false;
    if (hasDatabase(target)) {
      const count = checkDatabase(join(target, "notebook.sqlite"));
      const ok = await confirm("这个文件夹里已有笔记数据库", `里面有 ${count} 本笔记。改用它之后，当前位置的数据保持不变，可随时切回。`,
        "改用这里的数据并重启");
      if (!ok) return false;
      backups.create("before-move");
      restartWith(() => saveLocation(homedir(), target));
      return true;
    }
    const ok = await confirm(`把数据复制到「${target}」？`,
      "笔记、附件、账户配置和备份都会复制过去，之后从新位置运行。原位置的数据会保留，确认无误后可自行删除。", "复制并重启");
    if (!ok) return false;
    backups.create("before-move");
    copyData(store.db, local, target);
    restartWith(() => saveLocation(homedir(), target));
    return true;
  });
  handle("notebook:choose-folder", async (notebookId) => {
    const notebook = store.read(notebookId);
    const choice = await dialog.showOpenDialog(window, {
      title: "选择这个聊天的工作文件夹", defaultPath: notebook.workDir,
      properties: ["openDirectory", "createDirectory"]
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    return store.setWorkDir(notebook.id, choice.filePaths[0]);
  });
  handle("notebook:open-folder", async (notebookId) => {
    const folder = workingFolder(store.read(notebookId)) || join(local, "model-work");
    const error = await shell.openPath(folder);
    if (error) throw new Error("无法打开文件夹。");
  });
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
      if (hostname === "app" && pathname.startsWith("/note-image/")) {
        const id = pathname.slice("/note-image/".length);
        // Saved images (note blocks, sent attachments) and ones still waiting in a question box.
        const image = (item) => item?.id === id && [".png", ".jpg", ".jpeg", ".webp"].includes(item.extension);
        const ref = /^[\da-f-]{36}$/i.test(id) &&
          (storedAttachments().find(image) || [attachments.pendingRef(id)].find(image));
        return ref ? net.fetch(pathToFileURL(attachments.path(ref)).href) : new Response(null, { status: 404 });
      }
      const file = hostname === "app" && files.get(pathname);
      return file ? net.fetch(pathToFileURL(join(base, file)).href) : new Response(null, { status: 404 });
    });
    // Keep notes outside AppData: packaged apps (Codex, Claude desktop) silently redirect AppData
    // writes of programs they launch into private folders, which splits the notebook by launcher.
    ({ dataDir: local, source: dataSource } = resolveDataDir({ home: homedir(), override }));
    try {
      if (!override) finishPendingCopy(homedir());
      mkdirSync(local, { recursive: true });
    } catch (error) {
      dialog.showErrorBox("无法打开数据文件夹", `「${local}」：${error.message}\n请确认该磁盘已连接，然后重新打开应用。`);
      app.exit(1);
      return;
    }
    for (const name of readdirSync(local)) {
      if (/^(?:import|export)-\d{8}-\d{6}-\d+\.sqlite$/.test(name)) rmSync(join(local, name), { force: true });
    }
    store = new NotebookStore(join(local, "notebook.sqlite"));
    backups = new Backups(local, store.db);
    autoBackup();
    backupTimer = setInterval(autoBackup, autoBackupInterval);
    profiles = new Profiles(store.db);
    attachments = new AttachmentStore(join(local, "attachments"), join(local, "attachment-work"));
    await attachments.initialize(storedAttachments());
    handle("notebook:read", () => store.read());
    handle("library:read", () => store.library());
    handle("library:open", (id) => store.open(id));
    handle("library:create", ({ title, folderId }) => store.create(title, { folderId }));
    handle("library:rename", ({ id, title }) => store.renameNotebook(id, title));
    handle("library:move", ({ id, folderId }) => store.moveNotebook(id, folderId));
    handle("library:delete", async (id) => {
      if (activeTurn?.notebookId === id) throw new Error("请先停止生成，再删除会话。");
      const before = allAttachmentRefs(store.read(id));
      const result = store.deleteNotebook(id);
      await attachments.deleteSaved(before, storedAttachments());
      return result;
    });
    handle("folder:create", (name) => store.createFolder(name));
    handle("folder:rename", ({ id, name }) => store.renameFolder(id, name));
    handle("folder:delete", (id) => store.deleteFolder(id));
    handle("library:create-from-messages", ({ sourceId, ids }) => store.createFromMessages(sourceId, ids));
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
      if (!["delete-branch", "edit-document", "delete-note"].includes(action?.type)) return store.change(action, action.notebookId);
      const before = allAttachmentRefs(store.read(action.notebookId));
      const next = store.change(action, action.notebookId);
      await attachments.deleteSaved(before, storedAttachments());
      return next;
    });
    handle("attachments:stage", ({ paths, available }) => attachments.stage(paths, available));
    handle("note:add-images", async ({ notebookId, paths, afterId }) => {
      const entryName = (entry) => typeof entry === "string" ? entry : entry?.name;
      if (!Array.isArray(paths) || !paths.length || paths.length > 6 ||
          paths.some((entry) => typeof entryName(entry) !== "string" ||
            ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(entryName(entry)).toLowerCase()))) {
        throw new Error("请选择最多 6 张 PNG、JPG 或 WebP 图片。");
      }
      const { items, errors } = await attachments.stage(paths, paths.length);
      if (!items.length) return { state: store.read(notebookId), errors };
      try {
        const state = store.change({ type: "add-note-images", refs: items, afterId }, notebookId);
        attachments.commit(items);
        return { state, errors };
      } catch (error) {
        await Promise.allSettled(items.map((ref) => attachments.remove(ref.id)));
        throw error;
      }
    });
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
    handle("apps:info", () => appsInfo());
    // This chat's own members (the first change copies the app's default roster into the chat).
    handle("members:change", ({ notebookId, action }) => {
      const settings = profiles.read();
      const { state, result } = store.changeMembers(notebookId, action, settings,
        (provider) => providerAvatar(settings.appearance, provider));
      return { state, result };
    });
    handle("account:read", async (id) => {
      const profile = profiles.profile(id);
      const client = session(profile);
      const account = await client.account();
      const models = account.signedIn ? await client.models() : [];
      return { ...account, models };
    });
    // Quota as far as each CLI tells: Codex reports its usage windows on request; Claude Code only
    // mentions its limit status while answering, so the last one seen is shown.
    handle("account:limits", async (id) => {
      const profile = profiles.profile(id);
      if (profile.provider === "gpt") {
        const client = session(profile);
        if (!(await client.account()).signedIn) return { items: [], note: "未登录" };
        return { items: await client.rateLimits(), live: true };
      }
      if (profile.provider === "gemini") {
        // Antigravity's /usage report: remaining share of the 5-hour and weekly limits per model group.
        const quota = await session(profile).quota().catch(() => ({ items: [], text: "" }));
        return { items: quota.items, live: true, report: quota.items.length ? "" : quota.text.slice(0, 4000),
          note: quota.items.length || quota.text ? "" : "Antigravity 没有返回额度报告（可在终端运行 agy 后输入 /usage 查看）。" };
      }
      const seen = profiles.read().limits[profile.id];
      return { items: seen?.items || [], updated: seen?.updated,
        note: seen ? "" : "Claude Code 只在回答时附带额度状态；用这个账户回答一次后显示。" };
    });
    handle("account:login", async (id) => {
      const profile = profiles.profile(id);
      const client = session(profile);
      if (profile.provider !== "gpt") {
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
    setupDataHandlers();
    handle("turn:send", generate);
    handle("turn:stop", (id) => {
      if (activeTurn?.requestId === id) activeTurn.controller.abort(new Error("已停止生成。"));
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    autoBackup();
    shutDown();
  });
}
