import assert from "node:assert/strict";
import { test } from "node:test";
import { windowStartup } from "./window-startup.mjs";

function fake(load) {
  const state = { destroyed: false, url: "", shown: 0, focused: 0, restored: 0, stopped: 0, loads: 0 };
  const target = { isDestroyed: () => state.destroyed, isMinimized: () => true,
    restore: () => state.restored++, show: () => state.shown++, focus: () => state.focused++,
    webContents: { getURL: () => state.url, stop: () => state.stopped++ },
    loadURL: async (url) => { state.loads++; await load(state); state.url = url; } };
  return { state, target };
}

test("a failed first page load retries and reveals the window without ready-to-show", async () => {
  const { state, target } = fake((s) => { if (s.loads === 1) throw Error("ERR_ABORTED"); });
  const errors = [];
  const startup = windowStartup(target, { url: "notebook://app/index.html", report: (e) => errors.push(e.message) });
  assert.equal(await startup.start(), true);
  assert.equal(state.loads, 2);
  assert.equal(state.shown, 1);
  assert.equal(state.restored, 1);
  assert.deepEqual(errors, ["ERR_ABORTED"]);
  await startup.reopen();
  assert.equal(state.loads, 2, "reopening a working window must preserve its running chats");
  assert.equal(state.focused, 2);
});

test("a stalled initial navigation is stopped and retried", async () => {
  const { state, target } = fake((s) => s.loads === 1 ? new Promise(() => {}) : undefined);
  const startup = windowStartup(target, { url: "notebook://app/index.html", timeoutMs: 10 });
  assert.equal(await startup.start(), true);
  assert.equal(state.stopped, 1);
  assert.equal(state.loads, 2);
});

test("duplicate launches share the pending navigation and report a persistent failure once", async () => {
  const { state, target } = fake(() => Promise.reject(Error("page unavailable")));
  let failures = 0;
  const startup = windowStartup(target, { url: "notebook://app/index.html", failed: () => failures++ });
  const first = startup.start();
  assert.equal(startup.reopen(), first);
  assert.equal(await first, false);
  assert.equal(failures, 1);
  assert.equal(state.loads, 2);
  await startup.reopen();
  assert.equal(state.loads, 4, "another icon click can recover a previously failed window");
});

test("closing during startup does not revive the window or show an error dialog", async () => {
  const { state, target } = fake((s) => { s.destroyed = true; throw Error("window closed"); });
  let failures = 0;
  assert.equal(await windowStartup(target, { url: "notebook://app/index.html", failed: () => failures++ }).start(), false);
  assert.equal(state.loads, 1);
  assert.equal(state.shown, 1, "shown initially, never revived after closing");
  assert.equal(state.focused, 0);
  assert.equal(failures, 0);
});

test("an isolated hidden test window loads without appearing on the desktop", async () => {
  const { state, target } = fake(() => {});
  assert.equal(await windowStartup(target, { url: "notebook://app/index.html", hidden: true }).start(), true);
  assert.equal(state.shown, 0);
});

test("an empty window retries even if the first load promise resolved", async () => {
  const { state, target } = fake(() => {});
  const load = target.loadURL;
  target.loadURL = async (url) => { await load(url); if (state.loads === 1) state.url = ""; };
  assert.equal(await windowStartup(target, { url: "notebook://app/index.html" }).start(), true);
  assert.equal(state.loads, 2);
  assert.equal(state.shown, 1);
});

test("a working committed page is never reloaded because a subframe is still loading", async () => {
  const { state, target } = fake(() => new Promise(() => {}));
  target.loadURL = () => { state.loads++; state.url = "notebook://app/index.html"; return new Promise(() => {}); };
  assert.equal(await windowStartup(target, { url: state.url || "notebook://app/index.html", timeoutMs: 10 }).start(), true);
  assert.equal(state.loads, 1);
  assert.equal(state.stopped, 0);
});
