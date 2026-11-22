import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import { FakeModel } from "./fake-model.mjs";
import { allAttachmentRefs, AttachmentStore } from "./attachments.mjs";
import {
  commentInput, documentOrigin, mainHistory, noteOrigin, stripSpeaker, pdfCommentOrigin, sharedNoteBlocks, threadInput, turnInput
} from "./notebook.mjs";
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
  ["/comment-chat.mjs", "ui/comment-chat.mjs"], ["/pixel-avatars.mjs", "ui/pixel-avatars.mjs"],
  ["/chat-composer.mjs", "ui/chat-composer.mjs"], ["/threads-ui.mjs", "ui/threads-ui.mjs"],
  ["/pdf-note.mjs", "ui/pdf-note.mjs"], ["/features.css", "ui/features.css"], ["/splitter.mjs", "ui/splitter.mjs"], ["/windows.css", "ui/windows.css"]
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
const windows = new Set();
let store;
let profiles;
let attachments;
let local;
let dataSource;
let backups;
let backupTimer;
// Answers being generated, by request id. Several can run at once (side conversations with
// different members, the main chat, annotation follow-ups); each lane allows one at a time.
const activeTurns = new Map();
const autoBackupInterval = 6 * 60 * 60 * 1000;
const reviews = new Map();
const sessions = new Map();

function handle(name, operation) {
  ipcMain.handle(name, async (event, payload) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner) || event.senderFrame?.url !== entryUrl) {
      return { ok: false, error: "请求来源无效。" };
    }
    try {
      const data = await operation(payload, owner);
      if (/^(?:notebook:change|note:add-images|members:change|turn:send|turn:detach|thread:send|review:save|library:(?:create|rename|move|delete|create-from-messages)|folder:(?:create|rename|delete)|comment:fork|comment:send)$/.test(name)) {
        for (const other of windows) if (other !== owner && !other.isDestroyed()) {
          other.webContents.send("library:changed");
        }
      }
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });
}

function notify(event, value) {
  for (const target of windows) if (!target.isDestroyed()) target.webContents.send(event, value);
}

const dialogWindow = () => BrowserWindow.getFocusedWindow() || window;

async function approveCodex(method, params) {
  const permissions = method === "item/permissions/requestApproval";
  const fallback = permissions ? { permissions: {}, scope: "turn" } : { decision: "decline" };
  if (!dialogWindow() || dialogWindow().isDestroyed()) return fallback;
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
  const { response } = await dialog.showMessageBox(dialogWindow(), {
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
  // AI_NOTEBOOK_FAKE_MODELS=1 answers with canned text, for trying the interface without a subscription.
  const client = process.env.AI_NOTEBOOK_FAKE_MODELS === "1" ? new FakeModel(profile.provider)
    : profile.provider === "gpt" ? new Codex(work, directory, approveCodex)
    : profile.provider === "gemini" ? new Antigravity(work) : new Claude(work, directory);
  if (profile.provider === "gpt" && client.on) {
    client.on("account/login/completed", ({ success }) => {
      notify("account:status", { id: profile.id, success });
    });
  }
  sessions.set(profile.id, client);
  return client;
}

const storedAttachments = () => [...store.readAll().flatMap(allAttachmentRefs), ...store.pdfReviewAttachments()];

function beginTurn(entry) {
  requireText(entry.requestId, 100);
  if (activeTurns.has(entry.requestId)) throw new Error("请求重复。");
  for (const other of activeTurns.values()) {
    if (other.lane === entry.lane) throw new Error(entry.busy || "这里已有回答正在生成。");
  }
  const turn = { files: [], ...entry, controller: new AbortController() };
  activeTurns.set(entry.requestId, turn);
  return turn;
}

const turnsWhere = (test) => [...activeTurns.values()].some(test);

function openReview(id) {
  const review = reviews.get(id);
  if (!review) throw new Error("请先打开对应的 PDF 审阅文件。");
  return review;
}

// ---- PDF reviews: kept with the PDF (by its content), not with any chat ----------------------------
// Every reviewed PDF is copied into the data folder, so a review can be reopened from the sidebar
// whatever happens to the original file. Each open review gets a short-lived id for this session.

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reviewFolder = () => join(local, "reviews");
const attachmentHashes = new Map();

async function attachmentHash(ref) {
  if (!attachmentHashes.has(ref.id)) attachmentHashes.set(ref.id, sha256(await readFile(attachments.path(ref))));
  return attachmentHashes.get(ref.id);
}

// Annotations or a conversation found elsewhere (an .aipdf, an older PDF note) join the review.
function mergeReview(current, extra) {
  const union = (mine = [], theirs = []) => [...mine, ...theirs.filter((item) => !mine.some((own) => own.id === item.id))];
  return { comments: union(current?.comments, extra?.comments), chat: union(current?.chat, extra?.chat),
    page: current?.page || extra?.page || 1 };
}

async function startReview({ bytes, name, extra }) {
  const hash = sha256(bytes);
  const copy = join(reviewFolder(), `${hash}.pdf`);
  if (!existsSync(copy)) await writeFile(copy, bytes);
  let saved = store.pdfReview(hash);
  const added = extra && (extra.comments?.length || extra.chat?.length);
  if (!saved || added) saved = store.savePdfReview(hash, saved?.name || name, mergeReview(saved, extra));
  const id = randomUUID();
  reviews.set(id, { hash, name: saved.name, pdf: bytes, page: saved.page || 1 });
  return { id, hash, name: saved.name, pdf: bytes, comments: saved.comments, chat: saved.chat, page: saved.page || 1 };
}

// What to review: a file on disk, a chat attachment, a PDF note, or a PDF reviewed before.
async function reviewSource({ path, attachmentId, notebookId, blockId, hash }) {
  if (hash) {
    if (!/^[\da-f]{64}$/.test(hash)) throw new Error("审阅记录无效。");
    const saved = store.pdfReview(hash);
    const bytes = await readFile(join(reviewFolder(), `${hash}.pdf`)).catch(() => {
      throw new Error("找不到这份 PDF 的副本，请重新打开原文件。");
    });
    return { bytes, name: saved?.name || "PDF" };
  }
  if (blockId) {
    const { block, ref } = pdfNote(notebookId, blockId);
    return { bytes: await readFile(attachments.path(ref)), name: ref.name, extra: block.review };
  }
  if (attachmentId) {
    const ref = storedAttachments().find((item) => item.id === attachmentId && item.extension === ".pdf") ||
      attachments.pendingRef(attachmentId);
    if (!ref || ref.extension !== ".pdf") throw new Error("找不到这份 PDF 附件。");
    return { bytes: await readFile(attachments.path(ref)), name: ref.name };
  }
  const opened = await readReviewFile(path).catch((error) => {
    if (error.code === "ENOENT") throw new Error("找不到这个 PDF 文件。");
    throw error;
  });
  return { bytes: Buffer.from(opened.pdf), name: opened.name, extra: { comments: opened.comments, chat: opened.chat } };
}

// PDF notes carry their review into the group chat's context (annotations as text, the file as a path).
async function withReviews(notebook) {
  for (const block of notebook.blocks) {
    const ref = block.noteType === "pdf" && !block.removed && block.attachments?.[0];
    if (!ref) continue;
    try {
      const saved = store.pdfReview(await attachmentHash(ref));
      if (saved) block.review = { comments: saved.comments, chat: saved.chat };
    } catch {}
  }
  return notebook;
}

// Reviews kept inside PDF notes by the previous version move to the PDF's own review.
async function moveOldReviews() {
  for (const notebook of store.readAll()) {
    for (const block of notebook.blocks) {
      const ref = block.noteType === "pdf" && block.attachments?.[0];
      if (!ref || !(block.review?.comments?.length || block.review?.chat?.length)) continue;
      try {
        const bytes = await readFile(attachments.path(ref));
        const hash = sha256(bytes);
        const copy = join(reviewFolder(), `${hash}.pdf`);
        if (!existsSync(copy)) await writeFile(copy, bytes);
        const saved = store.pdfReview(hash);
        store.savePdfReview(hash, saved?.name || ref.name, mergeReview(saved, block.review));
      } catch (error) {
        console.error("Could not move a PDF review:", error);
      }
    }
  }
}

function pdfNote(notebookId, blockId) {
  const notebook = store.read(notebookId);
  const block = notebook.blocks.find((item) => item.id === blockId && !item.removed);
  if (block?.noteType !== "pdf" || !block.attachments?.[0]) throw new Error("这个 PDF 笔记已不存在。");
  return { notebook, block, ref: block.attachments[0] };
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
    screenshot: image ? { bytes: image, name: `${reference} · 框选截图` } : undefined,
    pdf: { bytes: review.pdf, name: review.name }
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
function speakers(notebook, memberIds) {
  const ids = Array.isArray(memberIds) ? [...new Set(memberIds.filter((id) => typeof id === "string"))] : [];
  if (ids.length > 8) throw new Error("一次最多 @ 8 位成员。");
  const group = roster(notebook);
  return ids.length ? ids.map((id) => lookup(group, id)) : [lookup(group)];
}

async function generate({ requestId, branchId, question, memberIds, attachmentIds, notebookId }) {
  requireText(requestId, 100);
  const files = attachments.pending(attachmentIds);
  const text = requireText(question || (files.length ? "请概述附件的主要内容。" : ""), 10_000).trim();
  const first = store.read(notebookId);
  const branch = branchId ? first.branches.find((item) => item.id === branchId) : null;
  if (branchId && !branch) throw new Error("这条分支已被删除。");
  const queue = speakers(first, memberIds);
  const cwd = workingFolder(first);
  const turn = beginTurn({ requestId, branchId, files, notebookId: first.id, question: text,
    lane: branchId ? `branch:${branchId}` : `main:${first.id}`, busy: "这个聊天已有回答正在生成。" });
  const { controller } = turn;
  let saved = first;
  try {
    for (const [index, speaker] of queue.entries()) {
      controller.signal.throwIfAborted();
      Object.assign(turn, { speaker, index });
      notify("turn:member", { requestId, index, total: queue.length, member: publicMember(speaker) });
      const notebook = await withReviews(store.read(first.id));
      const current = branch && notebook.branches.find((item) => item.id === branchId);
      if (branch && !current) throw new Error("这条分支已被删除。");
      // In a side branch each member's answer is its own turn, so later members see earlier ones there.
      const input = turnInput(notebook, current, text);
      // Later speakers see the question once, plus what the earlier members just said.
      // The last history entry is this question with their labelled answers, e.g. 【gpt1】….
      if (index > 0 && !branch) {
        const history = mainHistory(notebook);
        input.history = history.slice(0, -1).map(({ question: asked, answer }) => ({ question: asked, answer }));
        input.peers = history.at(-1)?.answer || "";
      }
      const earlier = current ? current.turns.flatMap((turn) => turn.attachments || [])
        : mainHistory(notebook).flatMap((turn) => turn.attachments);
      const sharedImages = sharedNoteBlocks(notebook).flatMap((block) => block.attachments || []);
      const prepared = await attachments.provide([...sharedImages, ...earlier, ...files], controller.signal,
        { inline: index ? [] : files });
      try {
        const { answer, source, tools } = await modelReply(speaker,
          { ...input, files: prepared.files, images: prepared.images, dirs: prepared.dirs }, controller, requestId, cwd,
          queue.map(({ member }) => member.name));
        // Moved to a private window while it was answering: the reply goes there, and members still
        // queued behind it are not asked (the user can ask them separately).
        if (turn.detached) {
          saved = store.saveThreadReply(first.id, turn.detached, { id: randomUUID(), question: text, answer, source,
            ...(tools.length ? { tools } : {}), ...(!index && files.length ? { attachments: files } : {}) });
          if (!index) attachments.commit(files);
          break;
        }
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
    activeTurns.delete(requestId);
  }
}

// One member's side conversation: the chat's context plus this window's turns.
async function generateThread({ requestId, notebookId, threadId, question, attachmentIds }) {
  requireText(requestId, 100);
  const files = attachments.pending(attachmentIds);
  const text = requireText(question || (files.length ? "请概述附件的主要内容。" : ""), 10_000).trim();
  const notebook = await withReviews(store.read(notebookId));
  const thread = (notebook.threads || []).find((item) => item.id === threadId);
  if (!thread) throw new Error("这个分头讨论窗口已关闭。");
  if (thread.turns.length >= 200) throw new Error("这个窗口的对话已达到上限，请发布后另开一个窗口。");
  const speaker = lookup(roster(notebook), thread.memberId);
  const cwd = workingFolder(notebook);
  const { controller } = beginTurn({ requestId, threadId, files, notebookId: notebook.id, lane: `thread:${threadId}`,
    busy: "这个窗口已有回答正在生成。" });
  let prepared;
  try {
    const earlier = [...mainHistory(notebook).flatMap((turn) => turn.attachments),
      ...thread.turns.flatMap((turn) => turn.attachments || [])];
    const sharedFiles = sharedNoteBlocks(notebook).flatMap((block) => block.attachments || []);
    prepared = await attachments.provide([...sharedFiles, ...earlier, ...files], controller.signal, { inline: files });
    const input = threadInput(notebook, thread, text);
    const reply = await modelReply(speaker, { ...input, files: prepared.files, images: prepared.images, dirs: prepared.dirs },
      controller, requestId, cwd);
    const turn = { id: randomUUID(), question: text, ...reply, ...(files.length ? { attachments: files } : {}) };
    const saved = store.saveThreadReply(notebook.id, threadId, turn);
    attachments.commit(files);
    return saved;
  } finally {
    await prepared?.dispose();
    activeTurns.delete(requestId);
  }
}

function commentTarget({ reviewId, comment, notebookId, noteId }) {
  if (reviewId) {
    const review = openReview(reviewId);
    const [checked] = validateComments([comment]);
    return { origin: pdfCommentOrigin(review.name, checked), turns: checked.turns || [],
      pdf: { bytes: review.pdf, name: review.name } };
  }
  const notebook = store.read(notebookId);
  const note = notebook.notes.find((item) => item.id === noteId);
  if (!note) throw new Error("这条批注已不存在。");
  return { origin: noteOrigin(notebook, note), turns: note.turns || [], notebookId: notebook.id, noteId,
    refs: note.attachments || [] };
}

// A conversation about a whole PDF under review: its annotations as context, its text attached.
function reviewDocumentTarget({ reviewId, comments, history }) {
  const review = openReview(reviewId);
  return {
    origin: documentOrigin(review.name, validateComments(comments || [])),
    turns: validateTurns(history),
    pdf: { bytes: review.pdf, name: review.name }
  };
}

async function generateComment(payload) {
  const { requestId, memberId } = payload;
  requireText(requestId, 100);
  const files = attachments.pending(payload.attachmentIds);
  const question = requireText(payload.question || (files.length ? "请看附件。" : ""), 10_000).trim();
  const target = payload.document ? reviewDocumentTarget(payload)
    : payload.selection ? reviewSelectionTarget(payload) : commentTarget(payload);
  if (payload.reviewId && target.turns.length >= 200) {
    throw new Error(payload.selection ? "选区问答已达到上限，请重新选择内容开始提问。" : "这段对话已达到上限，请新开分支继续。");
  }
  // A standalone PDF review belongs to no chat; its members are those of the chat it was opened from.
  const ownerId = target.notebookId || target.owner ||
    (typeof payload.rosterNotebookId === "string" ? payload.rosterNotebookId : undefined);
  const owner = ownerId ? store.read(ownerId) : null;
  const speaker = lookup(roster(owner), memberId);
  const cwd = owner ? workingFolder(owner) : undefined;
  const lane = target.noteId ? `note:${target.noteId}` : payload.document ? `review-chat:${payload.reviewId}`
    : `comment:${requestId}`;
  const { controller } = beginTurn({ requestId, files, notebookId: target.notebookId, noteId: target.noteId, lane,
    busy: "这里已有回答正在生成。" });
  let prepared;
  try {
    const earlier = [...(target.refs || []), ...target.turns.flatMap((turn) => turn.attachments || [])];
    prepared = await attachments.provide([...earlier, ...files], controller.signal,
      { inline: files, screenshot: target.screenshot, pdf: target.pdf });
    const input = commentInput(target.origin, target.turns, question);
    Object.assign(input, { files: prepared.files, images: prepared.images, dirs: prepared.dirs });
    const reply = await modelReply(speaker, input, controller, requestId, cwd);
    const turn = { id: randomUUID(), question, ...reply, ...(files.length ? { attachments: files } : {}) };
    const notebook = target.noteId ? store.saveNoteReply(target.notebookId, target.noteId, turn) : undefined;
    attachments.commit(files);
    return { turn, notebook };
  } finally {
    await prepared?.dispose();
    activeTurns.delete(requestId);
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
  for (const turn of activeTurns.values()) turn.controller.abort(new Error("应用已关闭。"));
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
  if (activeTurns.size) throw new Error("请先等待或停止正在生成的回答。");
}

async function confirm(message, detail, action) {
  const { response } = await dialog.showMessageBox(dialogWindow(), {
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
    const choice = await dialog.showOpenDialog(dialogWindow(), {
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
    const choice = await dialog.showSaveDialog(dialogWindow(), {
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
    const choice = await dialog.showOpenDialog(dialogWindow(), {
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
    const choice = await dialog.showOpenDialog(dialogWindow(), {
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

// review: the hash of the PDF this window reviews on its own (a PDF moved to another screen).
function createWindow(notebookId, review) {
  const target = new BrowserWindow({
    title: "AI 笔记本",
    width: review ? 1100 : 1360, height: 930, minWidth: review ? 520 : 730, minHeight: 540, show: false,
    icon: join(base, "notebook.ico"),
    autoHideMenuBar: true,
    webPreferences: { preload: join(base, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  target.notebookId = notebookId || store.activeId();
  target.reviewHash = review;
  windows.add(target);
  window ||= target;
  target.setMenu(null);
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.on("will-prevent-unload", (event) => {
    const answer = dialog.showMessageBoxSync(target, {
      type: "question", message: "PDF 批注有未保存的改动。",
      buttons: ["继续编辑", "放弃改动并关闭"], defaultId: 0, cancelId: 0
    });
    if (answer === 1) event.preventDefault();
  });
  target.once("ready-to-show", () => target.show());
  target.on("closed", () => {
    windows.delete(target);
    if (window === target) window = windows.values().next().value;
  });
  target.loadURL(entryUrl);
  return target;
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
      // PDF notes are previewed in the chat; only stored attachments can be read this way.
      if (hostname === "app" && pathname.startsWith("/note-file/")) {
        const id = pathname.slice("/note-file/".length);
        const ref = /^[\da-f-]{36}$/i.test(id) &&
          (storedAttachments().find((item) => item.id === id && item.extension === ".pdf") ||
            [attachments.pendingRef(id)].find((item) => item?.extension === ".pdf"));
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
    mkdirSync(reviewFolder(), { recursive: true });
    await moveOldReviews();
    handle("notebook:read", (_payload, owner) => store.read(owner.notebookId));
    handle("library:read", () => store.library());
    handle("library:open", (id, owner) => {
      const result = store.open(id);
      owner.notebookId = result.state.id;
      return result;
    });
    handle("window:open", (id) => {
      store.read(id);
      const target = createWindow(id);
      target.once("ready-to-show", () => target.focus());
      return true;
    });
    handle("window:mode", (_payload, owner) => ({ review: owner.reviewHash ? { hash: owner.reviewHash } : null }));
    // A PDF in a window of its own, e.g. on a second screen; asking again brings that window forward.
    const reviewWindow = (hash) => [...windows].find((item) => !item.isDestroyed() && item.reviewHash === hash);
    const reviewHashOf = async (spec) => spec.hash || (await startReview(await reviewSource(spec))).hash;
    handle("window:open-review", async (spec, owner) => {
      const hash = await reviewHashOf(spec);
      const existing = reviewWindow(hash);
      if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return true;
      }
      const target = createWindow(owner.notebookId, hash);
      target.once("ready-to-show", () => target.focus());
      return true;
    });
    handle("window:focus-review", async (spec, owner) => {
      const hash = spec.hash || (spec.attachmentId || spec.blockId) &&
        await attachmentHash(spec.blockId ? pdfNote(spec.notebookId, spec.blockId).ref
          : storedAttachments().find((item) => item.id === spec.attachmentId) || attachments.pendingRef(spec.attachmentId));
      const existing = hash && reviewWindow(hash);
      if (!existing || existing === owner) return false;
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return true;
    });
    // While a member is still answering in the main chat, its answer can move into a private window,
    // so the chat is free for the next question (whose context leaves the moved answer out).
    handle("turn:detach", (requestId) => {
      const turn = activeTurns.get(requestId);
      if (!turn || turn.branchId || !turn.lane?.startsWith("main:") || !turn.speaker) {
        throw new Error("这条回答已经完成，不能再转到小窗。");
      }
      // Its question stays in the chat as a folded card, unless it is there already (a later member).
      const notebook = store.change({ type: "add-thread", memberId: turn.speaker.member.id,
        ...(turn.index ? {} : { stub: turn.question }) }, turn.notebookId);
      const threadId = notebook.threads.at(-1).id;
      Object.assign(turn, { detached: threadId, threadId, lane: `thread:${threadId}` });
      return { notebook, threadId, member: publicMember(turn.speaker), index: turn.index };
    });
    handle("library:create", ({ title, folderId }, owner) => {
      const result = store.create(title, { folderId });
      owner.notebookId = result.state.id;
      return result;
    });
    handle("library:rename", ({ id, title }) => store.renameNotebook(id, title));
    handle("library:move", ({ id, folderId }) => store.moveNotebook(id, folderId));
    handle("library:delete", async (id, owner) => {
      if (turnsWhere((turn) => turn.notebookId === id)) throw new Error("请先停止生成，再删除会话。");
      const before = allAttachmentRefs(store.read(id));
      const result = store.deleteNotebook(id);
      for (const target of windows) if (target.notebookId === id) target.notebookId = result.state.id;
      await attachments.deleteSaved(before, storedAttachments());
      return result;
    });
    handle("folder:create", (name) => store.createFolder(name));
    handle("folder:rename", ({ id, name }) => store.renameFolder(id, name));
    handle("folder:delete", (id) => store.deleteFolder(id));
    handle("library:create-from-messages", ({ sourceId, ids }, owner) => {
      const result = store.createFromMessages(sourceId, ids);
      owner.notebookId = result.state.id;
      return result;
    });
    handle("comment:fork", (payload, owner) => {
      const { origin, turns } = commentTarget(payload);
      const label = (origin.kind === "pdf" ? origin.title : origin.text).trim().split(/\r?\n/, 1)[0].slice(0, 44);
      const result = store.create(`批注分支 · ${label || "追问"}`, { origin, turns });
      owner.notebookId = result.state.id;
      return result;
    });
    handle("comment:send", generateComment);
    handle("thread:send", generateThread);
    handle("notebook:change", async (action) => {
      if (action?.type === "delete-branch" && turnsWhere((turn) => turn.branchId === action.id)) {
        throw new Error("请先停止生成，再删除对话。");
      }
      if (action?.type === "delete-note" && turnsWhere((turn) => turn.noteId === action.id)) {
        throw new Error("请先停止这条批注的追问。");
      }
      if (["delete-thread", "delete-thread-turn"].includes(action?.type) && turnsWhere((turn) => turn.threadId === action.id)) {
        throw new Error("请先停止这个窗口正在生成的回答。");
      }
      if (!["delete-branch", "edit-document", "delete-note", "delete-thread", "delete-thread-turn"]
        .includes(action?.type)) return store.change(action, action.notebookId);
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
            ![".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(extname(entryName(entry)).toLowerCase()))) {
        throw new Error("请选择最多 6 个 PNG、JPG、WebP 图片或 PDF。");
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
      if (turnsWhere((turn) => turn.files.some((ref) => ref.id === id))) throw new Error("附件正在发送，请先停止生成。");
      return attachments.remove(id);
    });
    handle("attachments:open", async (id) => {
      const ref = storedAttachments().find((item) => item.id === id);
      if (!ref) throw new Error("附件已不存在。");
      const error = await shell.openPath(attachments.path(ref));
      if (error) throw new Error(`无法打开「${ref.name}」。`);
    });
    handle("review:open", async (spec) => startReview(await reviewSource(spec)));
    handle("review:list", () => store.pdfReviews());
    // How far a PDF note's review has come, for its card in the chat.
    handle("review:summary", async (attachmentId) => {
      const ref = storedAttachments().find((item) => item.id === attachmentId && item.extension === ".pdf");
      if (!ref) return null;
      const saved = store.pdfReview(await attachmentHash(ref));
      if (!saved) return { comments: [], chat: 0 };
      return { comments: [...saved.comments].sort((a, b) => a.page - b.page).slice(0, 4)
        .map(({ id, page, title, text }) => ({ id, page, title, text: text.slice(0, 200) })),
      commentCount: saved.comments.length, chat: saved.chat.length, page: saved.page };
    });
    handle("review:visit", ({ id, page }) => {
      const review = openReview(id);
      if (!Number.isInteger(page) || page < 1) throw new Error("页码无效。");
      review.page = page;
      store.pdfReviewPage(review.hash, page);
    });
    handle("review:release", (id) => { reviews.delete(id); });
    // Reviews save themselves as they change; "save as" exports an .aipdf to share elsewhere.
    handle("review:save", async ({ id, comments, chat = [], saveAs }) => {
      const current = openReview(id);
      if (!saveAs) {
        const saved = store.savePdfReview(current.hash, current.name, { comments, chat, page: current.page });
        return { hash: saved.hash, comments: saved.comments.length, chat: saved.chat.length };
      }
      const choice = await dialog.showSaveDialog(dialogWindow(), {
        title: "导出 PDF 审阅文件", defaultPath: `${basename(current.name, extname(current.name))}.aipdf`,
        filters: [{ name: "AI 笔记 PDF 审阅", extensions: ["aipdf"] }]
      });
      if (choice.canceled || !choice.filePath) return false;
      const path = extname(choice.filePath) ? choice.filePath : `${choice.filePath}.aipdf`;
      await saveReviewFile(path, current.pdf, current.name, comments, chat);
      return { exported: path };
    });
    handle("review:remove", async (hash) => {
      if ([...reviews.values()].some((item) => item.hash === hash)) throw new Error("这份 PDF 正在审阅中，请先关闭审阅。");
      store.removePdfReview(hash);
      rmSync(join(reviewFolder(), `${hash}.pdf`), { force: true });
      return store.pdfReviews();
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
      activeTurns.get(id)?.controller.abort(new Error("已停止生成。"));
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    autoBackup();
    shutDown();
  });
}
