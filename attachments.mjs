import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export const maxFilesPerMessage = 6;
const maxFileSize = 20 * 1024 * 1024;
const maxPdfPages = 60;
const maxPdfText = 100_000;
const maxImages = 12;
const extensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const storedName = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:pdf|png|jpg|jpeg|webp)$/i;
const require = createRequire(import.meta.url);
const pdfAssets = dirname(require.resolve("pdfjs-dist/package.json"));
const assetDirectory = (name) => join(pdfAssets, name).replaceAll("\\", "/") + "/";
let pdfModule;

export function allAttachmentRefs(state) {
  return [
    ...state.blocks.flatMap((block) => block.attachments || []),
    ...state.branches.flatMap((branch) => branch.turns.flatMap((turn) => turn.attachments || []))
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
      throw new Error(`「${name}」需要是 20 MB 以内的非空文件。`);
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

export async function readPdf(data, name, { signal, addImage, addText }) {
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
    if (pdf.numPages > maxPdfPages) {
      throw new Error(`「${name}」超过 ${maxPdfPages} 页，请先拆分后再添加。`);
    }
    for (let number = 1; number <= pdf.numPages; number += 1) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => typeof item.str === "string"
          ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        if (text) addText({ file: name, page: number, text });
        if (pdf.numPages <= 3 || text.replace(/\s/g, "").length < 35) {
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

  constructor(directory, work) {
    this.directory = directory;
    this.work = work;
  }

  async initialize(saved) {
    await Promise.all([mkdir(this.directory, { recursive: true }), mkdir(this.work, { recursive: true })]);
    const keep = new Set(saved.map((ref) => ref.id + ref.extension));
    for (const [dir, retain] of [[this.directory, keep], [this.work, new Set()]]) {
      const names = await readdir(dir, { withFileTypes: true });
      await Promise.allSettled(names.filter((entry) => entry.isFile() && storedName.test(entry.name) && !retain.has(entry.name))
        .map((entry) => unlink(join(dir, entry.name))));
    }
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
    for (const path of paths.slice(0, available)) {
      if (typeof path !== "string" || !path) {
        errors.push("请选择或拖入本机文件。");
        continue;
      }
      const name = basename(path);
      const extension = extname(name).toLowerCase();
      try {
        if (!extensions.has(extension)) throw new Error(`「${name}」不是支持的 PDF、PNG、JPG 或 WebP 文件。`);
        const data = await readCandidate(path, name);
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
    await Promise.allSettled(refs.filter((ref) => !keep.has(ref.id)).map((ref) => unlink(this.path(ref))));
  }

  async prepare(refs, signal, screenshot) {
    const documents = [];
    const images = [];
    const temp = [];
    let textLength = 0;
    let imageBytes = 0;
    const dispose = () => Promise.allSettled(temp.map((path) => unlink(path)));
    const addImage = async (data, name) => {
      if (images.length >= maxImages) {
        throw new Error(`每次最多读取 ${maxImages} 张图片或扫描页，请拆分文件或开启新分支。`);
      }
      imageBytes += data.length;
      if (imageBytes > 18 * 1024 * 1024) {
        throw new Error("图片内容太大，请缩小图片、拆分 PDF 或开启新分支。");
      }
      const path = join(this.work, randomUUID() + ".png");
      temp.push(path);
      await writeFile(path, data, { flag: "wx" });
      images.push({ path, name });
    };
    const addText = (entry) => {
      textLength += entry.text.length;
      if (textLength > maxPdfText) throw new Error("附件正文太长，请拆分 PDF 或开启新分支。");
      documents.push(entry);
    };
    try {
      if (screenshot) {
        signal.throwIfAborted();
        const data = Buffer.from(screenshot.bytes);
        if (!data.length || data.length > maxFileSize || !isExpectedFile(data, ".png")) {
          throw new Error("框选截图无效，请重新选择。");
        }
        await addImage(await resizeImage(data), screenshot.name);
      }
      for (const ref of new Map(refs.map((item) => [item.id, item])).values()) {
        signal.throwIfAborted();
        let data;
        try {
          data = await readFile(this.path(ref));
        } catch {
          throw new Error(`找不到本地附件「${ref.name}」。`);
        }
        if (ref.extension === ".pdf") await readPdf(data, ref.name, { signal, addImage, addText });
        else {
          let image;
          try {
            image = await resizeImage(data);
          } catch {
            throw new Error(`无法处理图片「${ref.name}」，请检查文件或缩小尺寸。`);
          }
          await addImage(image, ref.name);
        }
      }
      return { documents, images, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}
