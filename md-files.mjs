import { createHash, randomUUID } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dirname, basename, join, extname } from "node:path";
import { mdTextLimit, shiftAnnotations, mergeDocumentDraft } from "./md-document.mjs";
import { mergeText } from "./text-edits.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class MarkdownFiles {
  #queues = new Map();
  #watchers = new Map();
  constructor(store, { changed = () => {}, error = () => {} } = {}) { this.store = store; this.changed = changed; this.error = error; }
  #run(id, operation) {
    const work = (this.#queues.get(id) || Promise.resolve()).then(operation, operation);
    this.#queues.set(id, work);
    work.finally(() => { if (this.#queues.get(id) === work) this.#queues.delete(id); }).catch(() => {});
    return work;
  }
  async read(path) {
    if (![".md", ".markdown", ".mdown", ".mkd", ".txt"].includes(extname(path).toLowerCase())) throw new Error("请选择 Markdown 或文本文件。");
    const info = await stat(path);
    if (!info.isFile() || info.size > mdTextLimit) throw new Error("文档需要是 5 MB 以内的文本文件。");
    const bytes = await readFile(path);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
    catch { throw new Error("文档需要是 UTF-8 编码的文本。"); }
    return { text, hash: hash(bytes) };
  }
  #get(id) {
    const doc = this.store.mdDocument(id);
    if (!doc) throw new Error("这份文档已不存在。");
    return doc;
  }
  #update(doc, text, extra = {}) {
    const next = { ...doc, ...extra, text,
      comments: extra.comments || shiftAnnotations(doc.text, text, doc.comments),
      marks: extra.marks || shiftAnnotations(doc.text, text, doc.marks || []) };
    if (same({ ...doc, updated: 0 }, { ...next, updated: 0 })) return doc;
    return this.store.saveMdDocument(doc.id, { ...next, expectedVersion: doc.version });
  }
  async #refresh(doc) {
    if (!doc.path) return doc;
    let disk;
    try { disk = await this.read(doc.path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!doc.fileHash) return doc;
      disk = { text: "", hash: "missing", missing: true };
    }
    if (disk.hash === doc.fileHash) return doc;
    if (disk.hash === doc.fileConflict?.hash) return doc.text === disk.text ? this.#update(doc, disk.text,
      { fileHash: disk.hash, fileText: disk.text, fileConflict: null, unsynced: false }) : doc;
    this.store.mdVersion(doc.id, doc.text, "检测到文件变动前的应用版本", doc.fileHash);
    this.store.mdVersion(doc.id, disk.text, "外部文件版本", disk.hash);
    const merged = !doc.unsynced ? { clean: true, text: disk.text } :
      typeof doc.fileText === "string" ? mergeText(doc.fileText, doc.text, disk.text) : { clean: doc.text === disk.text, text: doc.text };
    if (!merged.clean || disk.missing) return this.#update(doc, doc.text,
      { fileConflict: { ...disk, detectedAt: Date.now(), kind: "disk" } });
    return this.#update(doc, merged.text, { fileText: disk.text, fileHash: disk.hash,
      unsynced: merged.text !== disk.text, fileConflict: null });
  }
  #watch(doc) {
    const previous = this.#watchers.get(doc.id);
    if (previous?.path === doc.path) return;
    if (previous) { unwatchFile(previous.path, previous.listener); this.#watchers.delete(doc.id); }
    if (!doc.path) return;
    const listener = () => this.open(doc.id).then((next) => { if (next.version !== doc.version) this.changed(doc.id); }).catch(this.error);
    watchFile(doc.path, { interval: 1000, persistent: false }, listener);
    this.#watchers.set(doc.id, { path: doc.path, listener });
  }
  open(id) { return this.#run(id, async () => { const doc = await this.#refresh(this.#get(id)); this.#watch(doc); return doc; }); }
  import(path) {
    const found = this.store.mdDocumentByPath(path);
    if (found) return this.open(found.id);
    return this.#run(path, async () => {
      const file = await this.read(path);
      const doc = this.store.saveMdDocument(randomUUID(), { name: basename(path), path, text: file.text, fileHash: file.hash, fileText: file.text });
      this.#watch(doc);
      return doc;
    });
  }
  save(id, input = {}, { toFile = false, path } = {}) {
    return this.#run(id, async () => {
      let doc = this.#get(id);
      const base = input.base || doc;
      const incomingText = typeof input.text === "string" ? input.text : base.text;
      const merged = mergeDocumentDraft(base, { text: incomingText, comments: input.comments || base.comments, marks: input.marks || base.marks }, doc);
      if (!merged.clean) {
        this.store.mdVersion(id, incomingText, "应用并发编辑草稿");
        throw new Error("文档在另一窗口也被修改，未覆盖任何内容；请先对照最新文档。当前编辑器保留你的草稿。");
      }
      const { comments, marks } = merged;
      doc = this.#update(doc, merged.text, { comments, marks, mode: input.mode || doc.mode, unsynced: doc.unsynced || merged.text !== doc.text });
      doc = await this.#refresh(doc);
      if (toFile && (!doc.fileConflict || (path && path !== doc.path))) doc = await this.#write(doc, path || doc.path);
      this.#watch(doc);
      return doc;
    });
  }
  async #write(doc, path) {
    if (!path) throw new Error("请先选择保存文件的位置。");
    let disk;
    try { disk = await this.read(path); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const samePath = path.toLowerCase() === doc.path.toLowerCase();
    if (samePath && disk?.hash !== (doc.fileHash || undefined)) return this.#refresh(doc);
    if (disk) this.store.mdVersion(doc.id, disk.text, "写回前的磁盘版本", disk.hash);
    this.store.mdVersion(doc.id, doc.text, "写回文件的应用版本", doc.fileHash);
    const bytes = Buffer.from(doc.text, "utf8"), temp = join(dirname(path), `.${basename(path)}.ownsoft-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      let latest;
      try { latest = await this.read(path); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (latest?.hash !== disk?.hash) {
        if (samePath) return this.#refresh(doc);
        throw new Error("目标文件刚被其他程序修改，已取消另存为，请重新核对。");
      }
      await rename(temp, path);
    } finally { await unlink(temp).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
    return this.#update(doc, doc.text, { path, name: basename(path), fileHash: hash(bytes), fileText: doc.text, unsynced: false, fileConflict: null });
  }
  resolve(id, { hash: expected, text, useDisk = false }) {
    return this.#run(id, async () => {
      let doc = this.#get(id);
      const disk = await this.read(doc.path).catch((e) => { if (e.code === "ENOENT") return { hash: "missing", text: "" }; throw e; });
      if (useDisk && disk.hash === "missing") throw new Error("原文件已不存在，可以把草稿重新写回或另存为。");
      if (typeof text === "string") this.store.mdVersion(id, text, "手工合并草稿");
      if (disk.hash !== expected) return this.#refresh(doc);
      this.store.mdVersion(id, doc.text, "手动处理冲突前的应用草稿", doc.fileHash);
      this.store.mdVersion(id, disk.text, "手动处理冲突时的磁盘版本", disk.hash);
      const chosen = useDisk ? disk.text : text;
      if (typeof chosen !== "string" || chosen.length > mdTextLimit) throw new Error("合并内容无效。");
      doc = this.#update(doc, chosen, { fileHash: disk.hash === "missing" ? "" : disk.hash, fileText: disk.text,
        unsynced: !useDisk && chosen !== disk.text, fileConflict: null });
      if (!useDisk) doc = await this.#write(doc, doc.path);
      return doc;
    });
  }
  close() { for (const value of this.#watchers.values()) unwatchFile(value.path, value.listener); this.#watchers.clear(); }
}
