// Portable notebook fixtures. Only the snapshot is changed; the live data stays untouched.
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { checkDatabase, databaseName, exportArchive, importArchive, snapshot } from "./datastore.mjs";

const credentialPattern = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/;
const nativeProviders = new Set(["gpt", "claude", "gemini"]);

export function exportTestbed(sourceDir, archive) {
  const stage = mkdtempSync(join(tmpdir(), "ownsoft-export-"));
  let source, db;
  try {
    source = new DatabaseSync(join(sourceDir, databaseName), { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000");
    snapshot(source, join(stage, databaseName));
    source.close(); source = null;
    db = new DatabaseSync(join(stage, databaseName));
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    const settings = tables.has("model_settings") ? JSON.parse(db.prepare("SELECT data FROM model_settings WHERE id=1").get()?.data || "{}") : {};
    const providers = new Map((settings.profiles || []).map(p => [p.id, p.provider]));
    for (const row of db.prepare("SELECT id,snapshot FROM notebook_documents").all()) {
      const doc = JSON.parse(row.snapshot);
      delete doc.workDir; delete doc.modelSessions;
      for (const member of doc.members || []) {
        const provider = providers.get(member.profileId);
        if (nativeProviders.has(provider)) member.profileId = `${provider}-native`;
      }
      db.prepare("UPDATE notebook_documents SET snapshot=? WHERE id=?").run(JSON.stringify(doc), row.id);
    }
    for (const row of db.prepare("SELECT id,data FROM md_documents").all()) {
      const data = JSON.parse(row.data);
      Object.assign(data, { fileText: null, fileHash: "", fileConflict: null, unsynced: true });
      db.prepare("UPDATE md_documents SET path=NULL,data=? WHERE id=?").run(JSON.stringify(data), row.id);
    }
    // Account configuration, native session identifiers, old undo payloads and local paths
    // are runtime state, not the user's notebook fixture.
    for (const table of ["model_settings", "notebook", "structure_log", "recent_pdf_review"])
      if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
    if (tables.has("todos")) db.exec("UPDATE todos SET ai=0");
    for (const table of ["notebook_documents", "chat_blocks", "chat_notes", "md_documents", "md_versions", "pdf_reviews"])
      if (tables.has(table)) for (const row of db.prepare(`SELECT * FROM ${table}`).all())
        for (const value of Object.values(row)) if (typeof value === "string" && credentialPattern.test(value))
          throw new Error(`检测到疑似凭据，已停止导出（${table}）。请先移除正文中的凭据。`);
    const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    const summary = { format: "ownsoft-testbed", version: 1, created: new Date().toISOString(),
      chats: count("notebook_documents"), childChats: count("child_chats"), blocks: count("chat_blocks"),
      markdownDocuments: count("md_documents"), pdfReviews: count("pdf_reviews"),
      markdownAnnotations: db.prepare("SELECT data FROM md_documents").all().reduce((n,r) => n + (JSON.parse(r.data).comments || []).length, 0),
      portable: { credentialsIncluded: false, localFileBindings: false, nativeSessionsIncluded: false, scheduledAIEnabled: false } };
    for (const folder of ["attachments", "attachments-trash", "reviews"])
      if (existsSync(join(sourceDir, folder))) cpSync(join(sourceDir, folder), join(stage, folder), { recursive: true });
    mkdirSync(dirname(archive), { recursive: true });
    exportArchive(db, stage, archive);
    summary.sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    return summary;
  } finally {
    source?.close(); db?.close(); rmSync(stage, { recursive: true, force: true });
  }
}

export function prepareTestbed(archive, target) {
  if (existsSync(join(target, databaseName))) throw new Error("目标已有笔记数据库，请换一个空目录，避免覆盖已有数据。");
  mkdirSync(target, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "ownsoft-import-"));
  try {
    const database = importArchive(archive, stage);
    const count = checkDatabase(database);
    for (const folder of ["attachments", "attachments-trash", "reviews"])
      if (existsSync(join(stage, folder))) cpSync(join(stage, folder), join(target, folder), { recursive: true, force: false, errorOnExist: true });
    // Exclusive creation also protects against a second importer racing this one.
    writeFileSync(join(target, databaseName), readFileSync(database), { flag: "wx" });
    return { target, chats: count };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
