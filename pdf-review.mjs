import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";

const pdfLimit = 60 * 1024 * 1024;
const jsonLimit = 2 * 1024 * 1024;
const members = new Map([["document.pdf", pdfLimit], ["review.json", jsonLimit]]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function pdfBytes(bytes) {
  if (!bytes?.length || bytes.length > pdfLimit ||
      !Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new Error("请选择有效且小于 60 MB 的 PDF。");
  }
  return bytes;
}

const attachmentRef = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

// Files attached to a follow-up question (kept in the notebook's attachment folder).
function validRefs(refs) {
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs) || refs.length > 6) throw new Error("一条批注对话记录无效。");
  return refs.map((ref) => {
    if (!attachmentRef.test(ref?.id || "") || ![".pdf", ".png", ".jpg", ".jpeg", ".webp"].includes(ref.extension) ||
        typeof ref.name !== "string" || !ref.name || ref.name.length > 250 || !Number.isFinite(ref.size)) {
      throw new Error("一条批注对话记录无效。");
    }
    return { id: ref.id, extension: ref.extension, name: ref.name, size: ref.size };
  });
}

const text = (value, limit) => String(value || "").slice(0, limit);

export function validateTurns(turns) {
  if (!Array.isArray(turns) || turns.length > 200) throw new Error("批注对话记录无效。");
  const ids = new Set();
  return turns.map((item) => {
    const { id, question, answer, source, tools, attachments } = item || {};
    if (typeof id !== "string" || !/^[a-zA-Z\d_-]{1,80}$/.test(id) || ids.has(id) ||
        typeof question !== "string" || !question.trim() || question.length > 10_000 ||
        typeof answer !== "string" || !answer.trim() || answer.length > jsonLimit) {
      throw new Error("一条批注对话记录无效。");
    }
    ids.add(id);
    const origin = source && ["gpt", "claude", "gemini"].includes(source.provider)
      ? { provider: source.provider, model: text(source.model, 100), effort: text(source.effort, 20),
        ...(source.memberId ? { memberId: text(source.memberId, 80), memberName: text(source.memberName, 24),
          avatar: text(source.avatar, 30) } : {}) }
      : undefined;
    const log = Array.isArray(tools) ? tools.slice(0, 80).map((tool) => ({
      id: text(tool?.id, 200), title: text(tool?.title, 100), detail: text(tool?.detail, 1200),
      status: ["running", "done", "failed"].includes(tool?.status) ? tool.status : "done" })) : [];
    const files = validRefs(attachments);
    return { id, question, answer, ...(origin ? { source: origin } : {}), ...(log.length ? { tools: log } : {}),
      ...(files?.length ? { attachments: files } : {}) };
  });
}

export function validateComments(comments) {
  if (!Array.isArray(comments) || comments.length > 1500) throw new Error("审阅批注列表无效。");
  const ids = new Set();
  return comments.map((comment) => {
    const { id, page, rects, title, text, quote = "", priority = "", turns } = comment || {};
    if (!/^[a-zA-Z\d_-]{1,80}$/.test(id || "") || ids.has(id) ||
        !Number.isInteger(page) || page < 1 || page > 3000 ||
        !Array.isArray(rects) || rects.length > 70 ||
        ![title, text, quote].every((value) => typeof value === "string") ||
        title.length > 160 || !text.trim() || text.length > 9000 || quote.length > 8000 ||
        !["", "P0", "P1", "P2"].includes(priority)) {
      throw new Error("一条审阅批注的内容或定位无效。");
    }
    ids.add(id);
    for (const rect of rects) {
      if (!Array.isArray(rect) || rect.length !== 4 ||
          !rect.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
          rect[2] <= rect[0] || rect[3] <= rect[1]) throw new Error("批注下划线的位置无效。");
    }
    return { id, page, rects, title, text, quote, priority, ...(turns !== undefined ? { turns: validateTurns(turns) } : {}) };
  });
}

export function encodeReview(pdf, name, comments, chat = []) {
  pdfBytes(pdf);
  const metadata = encoder.encode(JSON.stringify({
    format: "ai-notebook/pdf-review", version: 1,
    document: { name, sha256: hash(pdf) },
    comments: validateComments(comments),
    ...(chat.length ? { chat: validateTurns(chat) } : {})
  }));
  if (metadata.length > jsonLimit) throw new Error("批注内容超出审阅文件上限。");
  return zipSync({ "document.pdf": [pdf, { level: 0 }], "review.json": metadata }, { level: 3 });
}

export function decodeReview(bytes) {
  if (bytes.length > pdfLimit + jsonLimit + 1024) throw new Error("审阅文件过大。");
  const seen = new Set();
  const files = unzipSync(bytes, { filter: ({ name, originalSize, size }) => {
    const limit = members.get(name);
    if (!limit || originalSize > limit || size > bytes.length || seen.has(name)) {
      throw new Error("审阅文件的内容结构无效。");
    }
    seen.add(name);
    return true;
  } });
  const pdf = pdfBytes(files["document.pdf"]);
  const manifest = JSON.parse(decoder.decode(files["review.json"]));
  if (manifest.format !== "ai-notebook/pdf-review" || manifest.version !== 1) {
    throw new Error("此审阅文件的版本不受支持。");
  }
  if (manifest.document?.sha256 !== hash(pdf)) throw new Error("文件中的 PDF 与批注版本不匹配。");
  const name = manifest.document.name;
  if (typeof name !== "string" || !name.trim() || name.length > 250 || /[/\\\0]/.test(name)) {
    throw new Error("审阅文件的文档名称无效。");
  }
  return { pdf, name, comments: validateComments(manifest.comments),
    chat: manifest.chat === undefined ? [] : validateTurns(manifest.chat) };
}

export async function readReviewFile(path) {
  const extension = extname(path).toLowerCase();
  if (![".pdf", ".aipdf"].includes(extension)) throw new Error("请选择 PDF 或 .aipdf 审阅文件。");
  const { size } = await stat(path);
  if (size > pdfLimit + jsonLimit + 1024) throw new Error("文件超过 60 MB，请拆分后打开。");
  const bytes = await readFile(path);
  return extension === ".aipdf" ? { ...decodeReview(bytes), path }
    : { pdf: pdfBytes(bytes), name: basename(path), comments: [], chat: [] };
}

export async function saveReviewFile(path, pdf, name, comments, chat = []) {
  if (extname(path).toLowerCase() !== ".aipdf") throw new Error("请使用 .aipdf 扩展名保存。");
  const bytes = encodeReview(pdf, name, comments, chat);
  const temp = join(dirname(path), `.aipdf-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
