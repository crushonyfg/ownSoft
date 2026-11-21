// Where the notebook data lives, and how it is backed up, exported, restored and moved.
// Everything here is plain Node so it can be tested without Electron.
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, zipSync } from "fflate";

export const databaseName = "notebook.sqlite";
// Folders that belong to the notebook data (Electron caches are deliberately left out).
const dataFolders = ["attachments", "attachments-trash", "profiles", "model-work", "backups"];
const backupPattern = /^(auto|manual|before-restore|before-move)-(\d{8})-(\d{6})(?:-(\d+))?\.sqlite$/;
export const autoBackupsKept = 30;
const archiveFormat = "ai-notebook-backup";

const configDir = (home) => join(home, ".ai-notebook");
export const locationFile = (home) => join(configDir(home), "location.json");

// AI_NOTEBOOK_DATA_DIR wins, then the folder chosen in 数据管理, then ~/.ai-notebook.
export function resolveDataDir({ home, override }) {
  if (override) return { dataDir: override, source: "env" };
  try {
    const { dataDir } = JSON.parse(readFileSync(locationFile(home), "utf8"));
    if (typeof dataDir === "string" && isAbsolute(dataDir)) return { dataDir, source: "config" };
  } catch {}
  return { dataDir: configDir(home), source: "default" };
}

// copyFrom asks the next start to copy the data over first, once no running app is writing it.
export function saveLocation(home, dataDir, copyFrom) {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(locationFile(home), JSON.stringify({
    dataDir, ...(copyFrom ? { copyFrom } : {}), updated: new Date().toISOString()
  }, null, 2));
}

export function finishPendingCopy(home) {
  let config;
  try {
    config = JSON.parse(readFileSync(locationFile(home), "utf8"));
  } catch {
    return null;
  }
  if (typeof config.copyFrom !== "string" || typeof config.dataDir !== "string") return null;
  if (!hasDatabase(config.dataDir) && hasDatabase(config.copyFrom)) {
    const db = new DatabaseSync(join(config.copyFrom, databaseName));
    try {
      copyData(db, config.copyFrom, config.dataDir);
    } finally {
      db.close();
    }
  }
  saveLocation(home, config.dataDir);
  return config.copyFrom;
}

const pad = (value) => String(value).padStart(2, "0");
function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// A consistent copy of a live database, even while it is being written.
export function snapshot(db, target) {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
}

export function checkDatabase(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("damaged");
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebook_documents'").get();
    if (!table) throw new Error("not a notebook");
    return db.prepare("SELECT count(*) AS count FROM notebook_documents").get().count;
  } catch {
    throw new Error(`「${basename(file)}」不是可用的笔记数据库。`);
  } finally {
    db?.close();
  }
}

function folderSize(dir) {
  if (!existsSync(dir)) return { count: 0, size: 0 };
  let count = 0;
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    count += 1;
    size += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return { count, size };
}

export class Backups {
  constructor(dataDir, db) {
    this.dataDir = dataDir;
    this.dir = join(dataDir, "backups");
    this.db = db;
  }

  list() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).flatMap((name) => {
      const match = backupPattern.exec(name);
      if (!match) return [];
      const [, kind, day, time] = match;
      const created = new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6), +time.slice(0, 2),
        +time.slice(2, 4), +time.slice(4)).getTime();
      return [{ name, kind, created, size: statSync(join(this.dir, name)).size }];
    }).sort((a, b) => b.created - a.created || b.name.localeCompare(a.name));
  }

  path(name) {
    if (typeof name !== "string" || !backupPattern.test(name)) throw new Error("备份文件名无效。");
    const file = join(this.dir, name);
    if (!existsSync(file)) throw new Error("这份备份已不存在。");
    return file;
  }

  create(kind = "manual", now = new Date()) {
    mkdirSync(this.dir, { recursive: true });
    let name = `${kind}-${stamp(now)}.sqlite`;
    for (let n = 2; existsSync(join(this.dir, name)); n += 1) name = `${kind}-${stamp(now)}-${n}.sqlite`;
    snapshot(this.db, join(this.dir, name));
    if (kind === "auto") this.prune();
    return name;
  }

  prune(keep = autoBackupsKept) {
    for (const item of this.list().filter((entry) => entry.kind === "auto").slice(keep)) {
      rmSync(join(this.dir, item.name), { force: true });
    }
  }

  // Back up only when notes changed after the newest backup.
  autoIfChanged(now = new Date()) {
    const changed = this.db.prepare("SELECT max(updated) AS updated FROM notebook_documents").get()?.updated || 0;
    const newest = this.list()[0];
    if (newest && newest.created >= Math.floor(changed / 1000) * 1000) return null;
    return this.create("auto", now);
  }
}

export function dataInfo(dataDir, db, backups) {
  const file = join(dataDir, databaseName);
  const size = [file, `${file}-wal`].reduce((sum, path) => sum + (existsSync(path) ? statSync(path).size : 0), 0);
  return {
    dataDir,
    notebooks: db.prepare("SELECT count(*) AS count FROM notebook_documents").get().count,
    databaseSize: size,
    attachments: folderSize(join(dataDir, "attachments")),
    trash: folderSize(join(dataDir, "attachments-trash")),
    backups: backups.list(),
    autoBackupsKept
  };
}

// Swap in another database file. The caller must have closed the live database first.
export function replaceDatabase(dataDir, source) {
  checkDatabase(source);
  const target = join(dataDir, databaseName);
  for (const suffix of ["-wal", "-shm"]) rmSync(target + suffix, { force: true });
  copyFileSync(source, target);
}

// A single .zip with the database and every attachment, for keeping elsewhere.
export function exportArchive(db, dataDir, file, now = new Date()) {
  const temp = join(dataDir, `export-${stamp(now)}-${process.pid}.sqlite`);
  try {
    snapshot(db, temp);
    const entries = {
      "manifest.json": new TextEncoder().encode(JSON.stringify({ format: archiveFormat, version: 1, created: now.toISOString() })),
      [databaseName]: readFileSync(temp)
    };
    for (const folder of ["attachments", "attachments-trash"]) {
      const dir = join(dataDir, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isFile()) entries[`${folder}/${name}`] = readFileSync(path);
      }
    }
    writeFileSync(file, zipSync(entries, { level: 6 }));
  } finally {
    rmSync(temp, { force: true });
  }
}

// Unpacks an exported .zip: attachments go back in place (existing files are kept) and the
// database is written to a temporary file the caller then installs with replaceDatabase.
export function importArchive(file, dataDir) {
  let entries;
  try {
    entries = unzipSync(readFileSync(file));
  } catch {
    throw new Error("无法读取这个备份压缩包。");
  }
  const manifest = entries["manifest.json"] && JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
  if (manifest?.format !== archiveFormat || !entries[databaseName]) throw new Error("这不是 AI 笔记本导出的备份。");
  for (const [name, data] of Object.entries(entries)) {
    const match = /^(attachments|attachments-trash)\/([\w.-]+)$/.exec(name);
    if (!match) continue;
    const dir = join(dataDir, match[1]);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, match[2]))) writeFileSync(join(dir, match[2]), data);
  }
  const temp = join(dataDir, `import-${stamp()}-${process.pid}.sqlite`);
  writeFileSync(temp, entries[databaseName]);
  return temp;
}

export function hasDatabase(dir) {
  return existsSync(join(dir, databaseName));
}

// Copy the live data to a new folder. The old folder is left untouched as a fallback.
export function copyData(db, from, to) {
  if (hasDatabase(to)) throw new Error("目标文件夹里已经有笔记数据库。");
  mkdirSync(to, { recursive: true });
  snapshot(db, join(to, databaseName));
  for (const folder of dataFolders) {
    const source = join(from, folder);
    if (existsSync(source)) cpSync(source, join(to, folder), { recursive: true, force: false, errorOnExist: false });
  }
  checkDatabase(join(to, databaseName));
}
