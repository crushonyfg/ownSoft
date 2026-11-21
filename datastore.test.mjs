import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Backups, checkDatabase, copyData, exportArchive, finishPendingCopy, importArchive, replaceDatabase, resolveDataDir,
  saveLocation
} from "./datastore.mjs";
import { AttachmentStore } from "./attachments.mjs";
import { NotebookStore } from "./store.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "notebook-data-test-"));

test("the data folder comes from the env override, then the saved location, then the home folder", () => {
  const home = temp();
  assert.deepEqual(resolveDataDir({ home }), { dataDir: join(home, ".ai-notebook"), source: "default" });
  saveLocation(home, "D:\\AI Notebook Data");
  assert.deepEqual(resolveDataDir({ home }), { dataDir: "D:\\AI Notebook Data", source: "config" });
  assert.equal(resolveDataDir({ home, override: "E:\\x" }).source, "env");
});

test("backups snapshot only after changes, keep a bounded number, and restore into place", () => {
  const dir = temp();
  const store = new NotebookStore(join(dir, "notebook.sqlite"));
  const backups = new Backups(dir, store.db);
  try {
    store.saveReply(null, "问题", "回答");
    const first = backups.autoIfChanged(new Date(Date.now() + 2000));
    assert.match(first, /^auto-/);
    assert.equal(backups.autoIfChanged(new Date(Date.now() + 3000)), null);
    for (let i = 0; i < 3; i += 1) backups.create("auto", new Date(2030, 0, 1, 0, 0, i));
    backups.prune(2);
    assert.equal(backups.list().filter((item) => item.kind === "auto").length, 2);
    const manual = backups.create("manual");
    assert.equal(checkDatabase(backups.path(manual)), 1);
    assert.throws(() => backups.path("../notebook.sqlite"), /无效/);
    store.change({ type: "edit-document", title: "改过的标题" });
    const saved = join(dir, "saved.sqlite");
    store.db.exec(`VACUUM INTO '${saved.replaceAll("'", "''")}'`);
    store.close();
    replaceDatabase(dir, backups.path(manual));
    const restored = new NotebookStore(join(dir, "notebook.sqlite"));
    assert.equal(restored.read().title, "我的工作笔记");
    restored.close();
    assert.throws(() => replaceDatabase(dir, join(dir, "missing.sqlite")), /不是可用的笔记数据库/);
  } finally {
    try { store.close(); } catch {}
  }
});

test("a full export carries attachments, and copying data leaves the original intact", () => {
  const dir = temp();
  const store = new NotebookStore(join(dir, "notebook.sqlite"));
  try {
    mkdirSync(join(dir, "attachments"));
    writeFileSync(join(dir, "attachments", "11111111-2222-4333-8444-555555555555.png"), "png");
    store.saveReply(null, "导出", "内容");
    const archive = join(dir, "backup.zip");
    exportArchive(store.db, dir, archive);
    const other = temp();
    const database = importArchive(archive, other);
    assert.equal(checkDatabase(database), 1);
    assert.ok(existsSync(join(other, "attachments", "11111111-2222-4333-8444-555555555555.png")));
    const target = join(temp(), "moved");
    copyData(store.db, dir, target);
    assert.equal(checkDatabase(join(target, "notebook.sqlite")), 1);
    assert.deepEqual(readdirSync(join(target, "attachments")), ["11111111-2222-4333-8444-555555555555.png"]);
    assert.ok(existsSync(join(dir, "notebook.sqlite")));
    assert.throws(() => copyData(store.db, dir, target), /已经有笔记数据库/);
  } finally {
    store.close();
  }
});

test("a pending move copies the data on the next start and then runs from the new folder", () => {
  const home = temp();
  const old = join(home, ".ai-notebook");
  mkdirSync(old, { recursive: true });
  const store = new NotebookStore(join(old, "notebook.sqlite"));
  store.saveReply(null, "旧位置", "数据");
  store.close();
  const target = join(home, "D-drive", "AI Notebook Data");
  saveLocation(home, target, old);
  assert.equal(finishPendingCopy(home), old);
  assert.equal(checkDatabase(join(target, "notebook.sqlite")), 1);
  assert.ok(existsSync(join(old, "notebook.sqlite")));
  assert.deepEqual(resolveDataDir({ home }), { dataDir: target, source: "config" });
  assert.equal(finishPendingCopy(home), null);
});

test("unused attachments move to the trash and come back when a restored note needs them", async () => {
  const dir = temp();
  const ref = { id: "11111111-2222-4333-8444-555555555555", extension: ".png", name: "a.png" };
  const files = new AttachmentStore(join(dir, "attachments"), join(dir, "work"));
  await files.initialize([]);
  writeFileSync(files.path(ref), "png");
  await files.deleteSaved([ref], []);
  assert.deepEqual(readdirSync(join(dir, "attachments")), []);
  assert.deepEqual(readdirSync(join(dir, "attachments-trash")), [`${ref.id}.png`]);
  await files.initialize([ref]);
  assert.deepEqual(readdirSync(join(dir, "attachments")), [`${ref.id}.png`]);
});

test("a notebook remembers its working folder", () => {
  const store = new NotebookStore(":memory:");
  try {
    const id = store.read().id;
    assert.throws(() => store.setWorkDir(id, "relative/path"), /无效/);
    store.setWorkDir(id, "D:\\projects\\paper");
    assert.equal(store.read().workDir, "D:\\projects\\paper");
    store.change({ type: "clear-work-dir" });
    assert.equal(store.read().workDir, undefined);
  } finally {
    store.close();
  }
});
