import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export const maxFilesPerMessage = 6;
const maxFileSize = 100 * 1024 * 1024;
// Images sent along with one question (the ones attached to it, or a box cut from a PDF page).
const maxImages = 12;
const extensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const storedName = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:pdf|png|jpg|jpeg|webp)$/i;
const require = createRequire(import.meta.url);
const pdfAssets = dirname(require.resolve("pdfjs-dist/package.json"));
const assetDirectory = (name) => join(pdfAssets, name).replaceAll("\\", "/") + "/";
let pdfModule;

const turnFiles = (turns = []) => turns.flatMap((turn) => turn.attachments || []);

// Every file a notebook still uses: messages, note blocks (PDF notes and their review chats),
// annotations and their follow-ups, side branches and side conversations with single members.
export function allAttachmentRefs(state) {
  return [
    ...state.blocks.flatMap((block) => [...(block.attachments || []),
      ...turnFiles(block.review?.chat), ...(block.review?.comments || []).flatMap((item) => turnFiles(item.turns))]),
    ...state.branches.flatMap((branch) => turnFiles(branch.turns)),
    ...(state.notes || []).flatMap((note) => [...(note.attachments || []), ...turnFiles(note.turns)]),
    ...(state.threads || []).flatMap((thread) => turnFiles(thread.turns))
  ];
}

function isExpectedFile(data, extension) {
  if (extension === ".pdf") return data.subarray(0, 1024).includes(Buffer.from("%PDF-"));
  if (extension === ".png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".webp") return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

async function readCandidate(path, name) {
  const file = await open(path, "r");
  try {
    const status = await file.stat();
    if (!status.isFile() || status.size < 1 || status.size > maxFileSize) {
      throw new Error(`「${name}」需要是 100 MB 以内的非空文件。`);
    }
    const data = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error(`「${name}」在读取时已修改，请重新选择。`);
      offset += bytesRead;
    }
    return data;
  } finally {
    await file.close();
  }
}

async function resizeImage(data) {
  const image = await loadImage(data);
  if (image.width < 1 || image.height < 1 || image.width * image.height > 80_000_000) {
    throw new Error("图片尺寸过大或无效。");
  }
  const scale = Math.min(1, 1900 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.encode("png");
}

// Reads a PDF's text page by page; render: also draw pages with little text (scans) as images.
// Returns the page count.
export async function readPdf(data, name, { signal, addImage = async () => {}, addText, render = true, maxPages = 5000 }) {
  pdfModule ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = await pdfModule;
  const task = getDocument({
    data: Uint8Array.from(data), isEvalSupported: false, maxImageSize: 40_000_000,
    cMapUrl: assetDirectory("cmaps"), cMapPacked: true,
    standardFontDataUrl: assetDirectory("standard_fonts"),
    wasmUrl: assetDirectory("wasm")
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages) {
      throw new Error(`「${name}」超过 ${maxPages} 页，请先拆分后再添加。`);
    }
    for (let number = 1; number <= pdf.numPages; number += 1) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => typeof item.str === "string"
          ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        if (text) addText({ file: name, page: number, text });
        if (render && (pdf.numPages <= 3 || text.replace(/\s/g, "").length < 35)) {
          const box = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(3, 1700 / Math.max(box.width, box.height)) });
          const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
          await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
          await addImage(await canvas.encode("png"), `${name} · 第 ${number} 页`);
        }
      } finally {
        page.cleanup();
      }
    }
    return pdf.numPages;
  } catch (error) {
    if (error.name === "PasswordException") throw new Error(`「${name}」有密码保护，请先解锁。`);
    if (error.name === "InvalidPDFException") throw new Error(`无法读取「${name}」，请检查 PDF 是否完整。`);
    throw error;
  } finally {
    await task.destroy();
  }
}

export class AttachmentStore {
  #pending = new Map();

  // Saved files that no message uses any more go to `trash` instead of being deleted, so restoring
  // an older backup of the notes can bring them back.
  constructor(directory, work, trash = join(dirname(directory), "attachments-trash"),
    texts = join(dirname(directory), "attachment-text")) {
    this.directory = directory;
    this.work = work;
    this.trash = trash;
    // Text pulled out of PDFs once (page by page), and PDFs from open reviews, for models to read.
    this.texts = texts;
  }

  async #discard(name) {
    await rename(join(this.directory, name), join(this.trash, name));
  }

  async initialize(saved) {
    await Promise.all([this.directory, this.work, this.trash, this.texts].map((dir) => mkdir(dir, { recursive: true })));
    const keep = new Set(saved.map((ref) => ref.id + ref.extension));
    const present = new Set((await readdir(this.directory)).filter((name) => storedName.test(name)));
    // Files referenced again (for example after restoring a backup) come back from the trash.
    await Promise.allSettled([...keep].filter((name) => storedName.test(name) && !present.has(name))
      .map(async (name) => {
        await access(join(this.trash, name));
        await rename(join(this.trash, name), join(this.directory, name));
      }));
    await Promise.allSettled([...present].filter((name) => !keep.has(name)).map((name) => this.#discard(name)));
    const work = await readdir(this.work, { withFileTypes: true });
    await Promise.allSettled(work.filter((entry) => entry.isFile() && storedName.test(entry.name))
      .map((entry) => unlink(join(this.work, entry.name))));
  }

  path(ref) {
    const name = ref.id + ref.extension;
    if (!storedName.test(name)) throw new Error("附件路径无效。");
    return join(this.directory, name);
  }

  async stage(paths, available) {
    const items = [];
    const errors = [];
    if (!Array.isArray(paths) || !Number.isInteger(available) || available < 1 || available > maxFilesPerMessage) {
      throw new Error(`每条消息最多添加 ${maxFilesPerMessage} 个附件。`);
    }
    // Each entry is a local path, or { name, data } for pasted or dragged content that has no file.
    for (const entry of paths.slice(0, available)) {
      const inline = entry && typeof entry === "object" && ArrayBuffer.isView(entry.data);
      if (!inline && (typeof entry !== "string" || !entry)) {
        errors.push("请选择或拖入本机文件。");
        continue;
      }
      const name = inline ? String(entry.name || "粘贴的图片.png").slice(0, 120) : basename(entry);
      const extension = extname(name).toLowerCase();
      try {
        if (!extensions.has(extension)) throw new Error(`「${name}」不是支持的 PDF、PNG、JPG 或 WebP 文件。`);
        if (inline && (entry.data.byteLength < 1 || entry.data.byteLength > maxFileSize)) {
          throw new Error(`「${name}」需要是 100 MB 以内的非空文件。`);
        }
        const data = inline ? Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
          : await readCandidate(entry, name);
        if (!isExpectedFile(data, extension)) throw new Error(`「${name}」的内容与文件格式不匹配。`);
        const ref = { id: randomUUID(), extension, name, size: data.length };
        await writeFile(this.path(ref), data, { flag: "wx" });
        this.#pending.set(ref.id, ref);
        items.push(ref);
      } catch (error) {
        errors.push(error.code ? `无法读取「${name}」。` : error.message);
      }
    }
    if (paths.length > available) errors.push(`每条消息最多添加 ${maxFilesPerMessage} 个附件。`);
    return { items, errors };
  }

  pendingRef(id) {
    return this.#pending.get(id);
  }

  pending(ids = []) {
    if (!Array.isArray(ids) || ids.length > maxFilesPerMessage) throw new Error("附件列表无效。");
    return [...new Set(ids)].map((id) => {
      const ref = this.#pending.get(id);
      if (!ref) throw new Error("附件已移除，请重新添加。");
      return ref;
    });
  }

  commit(refs) {
    for (const ref of refs) this.#pending.delete(ref.id);
  }

  async remove(id) {
    const ref = this.#pending.get(id);
    if (!ref) return;
    await unlink(this.path(ref));
    this.#pending.delete(id);
  }

  async deleteSaved(refs, retained) {
    const keep = new Set(retained.map((ref) => ref.id));
    await Promise.allSettled(refs.filter((ref) => !keep.has(ref.id)).map((ref) => this.#discard(basename(this.path(ref)))));
  }

  // A PDF's text, extracted once and kept next to the attachments, marked page by page.
  async #pdfText(path, key, name, signal) {
    const text = join(this.texts, `${key}.txt`);
    const info = join(this.texts, `${key}.json`);
    try {
      return { textPath: text, ...JSON.parse(await readFile(info, "utf8")) };
    } catch {}
    const parts = [];
    let chars = 0;
    const pages = await readPdf(await readFile(path), name, { signal, render: false,
      addText: (entry) => {
        chars += entry.text.length;
        parts.push(`===== 第 ${entry.page} 页 =====\n${entry.text}`);
      } });
    await writeFile(text, parts.join("\n\n") || "（这份 PDF 没有可抽取的文字，可能是扫描版。）", "utf8");
    const summary = { pages, chars };
    await writeFile(info, JSON.stringify(summary), "utf8");
    return { textPath: text, ...summary };
  }

  /**
   * What a model gets for a question: the files as paths it can open with its own tools (with each
   * PDF's extracted text), and the images it should see right away (those attached to this very
   * question, and a box cut from a PDF page). Nothing is size-limited by the app; the model reads
   * what it needs.
   *  refs: every file the conversation uses; inline: the ones attached to this question;
   *  screenshot: { bytes, name } of a PDF box; pdf: { bytes, name } of a PDF open for review.
   */
  async provide(refs, signal, { inline = [], screenshot, pdf } = {}) {
    const images = [];
    const files = [];
    const temp = [];
    const dispose = () => Promise.allSettled(temp.map((path) => unlink(path)));
    const addImage = async (data, name) => {
      if (images.length >= maxImages) return;
      const path = join(this.work, randomUUID() + ".png");
      temp.push(path);
      await writeFile(path, data, { flag: "wx" });
      images.push({ path, name });
    };
    const now = new Set(inline.map((ref) => ref.id));
    try {
      if (screenshot) {
        signal.throwIfAborted();
        const data = Buffer.from(screenshot.bytes);
        if (!data.length || data.length > maxFileSize || !isExpectedFile(data, ".png")) {
          throw new Error("框选截图无效，请重新选择。");
        }
        await addImage(await resizeImage(data), screenshot.name);
      }
      if (pdf) {
        // A review's PDF may live inside an .aipdf; a copy named by its content is kept to be read.
        const bytes = Buffer.from(pdf.bytes);
        const key = `review-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
        const path = join(this.texts, `${key}.pdf`);
        await access(path).catch(() => writeFile(path, bytes));
        files.push({ name: pdf.name, kind: "pdf", path, subject: true, ...(await this.#pdfText(path, key, pdf.name, signal)) });
      }
      for (const ref of new Map(refs.map((item) => [item.id, item])).values()) {
        signal.throwIfAborted();
        const path = this.path(ref);
        try {
          await access(path);
        } catch {
          files.push({ name: ref.name, kind: "missing" });
          continue;
        }
        if (ref.extension === ".pdf") {
          files.push({ name: ref.name, kind: "pdf", path, current: now.has(ref.id),
            ...(await this.#pdfText(path, ref.id, ref.name, signal)) });
          continue;
        }
        files.push({ name: ref.name, kind: "image", path, current: now.has(ref.id) });
        if (now.has(ref.id)) {
          try {
            await addImage(await resizeImage(await readFile(path)), ref.name);
          } catch {
            throw new Error(`无法处理图片「${ref.name}」，请检查文件或缩小尺寸。`);
          }
        }
      }
      return { files, images, dirs: [this.directory, this.texts], dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}
