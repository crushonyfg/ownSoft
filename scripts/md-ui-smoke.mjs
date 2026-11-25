// Isolated Electron regression: real UI + fake models, never the user's database or subscription.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { NotebookStore } from "../store.mjs";

const base = resolve(import.meta.dirname, ".."), profile = await mkdtemp(join(tmpdir(), "ownsoft-md-ui-"));
const text = "# Paper\n\nAlpha paragraph for review.\n\nBeta paragraph for another question.\n";
const path = join(profile, "paper.md"), mdId = randomUUID();
await writeFile(path, text);
const store = new NotebookStore(join(profile, "notebook.sqlite"));
store.saveReply(null, "Demo question", "Demo answer.");
store.saveMdDocument(mdId, { name: "paper.md", path, text, fileHash: createHash("sha256").update(text).digest("hex"), fileText: text,
  comments: [{ id: "initial", start: text.indexOf("Alpha"), quote: "Alpha", title: "Original annotation", text: "Original explanation." }] });
store.close();
const child = spawn(join(base, "node_modules/electron/dist/electron.exe"), [base, "--inspect=0", "--disable-gpu"],
  { windowsHide: true, env: { ...process.env, AI_NOTEBOOK_DATA_DIR: profile, AI_NOTEBOOK_FAKE_MODELS: "1", AI_NOTEBOOK_TEST_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"] });
let log = "", ws, sequence = 0;
const pending = new Map();
child.stderr.on("data", (data) => { log = (log + data).slice(-15_000); });
child.stdout.on("data", (data) => { log = (log + data).slice(-15_000); });
async function until(check, timeout = 35_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(80); }
  throw new Error("UI condition timed out");
}
function command(method, params = {}) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout: ${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer });
  });
  ws.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const requireElectron = `process.getBuiltinModule("module").createRequire(${JSON.stringify(join(base, "package.json"))})("electron")`;
const windowExpr = `${requireElectron}.BrowserWindow.getAllWindows()[0]`;
async function ui(expression, chatId) {
  return evaluate(`(async()=>{const w=${windowExpr};const f=${chatId ? `w.webContents.mainFrame.framesInSubtree.find(f=>new URL(f.url).searchParams.get("embed")===${JSON.stringify(chatId)})` : "w.webContents.mainFrame"};if(!f)return null;return f.executeJavaScript(${JSON.stringify(expression)});})()`);
}
async function select(word) {
  await ui(`(()=>{const root=document.getElementById("md-preview"),walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=walk.nextNode()){const at=n.textContent.indexOf(${JSON.stringify(word)});if(at>=0){const range=document.createRange();range.setStart(n,at);range.setEnd(n,at+${word.length});const s=window.getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event("selectionchange"));return true;}}throw Error("Selection text missing");})()`);
}
async function ask(word) {
  const previous = await ui('document.querySelector("#md-document-conversation iframe")?.dataset.chatId');
  await select(word);
  await ui('document.getElementById("md-tools-ask").click()');
  const id = await until(async () => { const id = await ui('document.querySelector("#md-document-conversation iframe")?.dataset.chatId'); return id && id !== previous ? id : null; });
  await until(() => ui('!!document.querySelector("#main-composer textarea")', id));
  await ui('(()=>{const input=document.querySelector("#main-composer textarea");input.value="Explain this passage";input.dispatchEvent(new Event("input",{bubbles:true}));input.closest("form").requestSubmit();})()', id);
  await until(() => ui('(async()=>{const s=await notebook.read(new URLSearchParams(location.search).get("embed"));return document.getElementById("main-pending").hidden&&s.blocks.some(b=>b.kind==="reply"&&!b.removed);})()', id));
  return id;
}
try {
  const endpoint = await until(() => log.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]);
  ws = new WebSocket(endpoint); await once(ws, "open");
  ws.addEventListener("message", ({ data }) => {
    const item = JSON.parse(data), waiting = pending.get(item.id);
    if (!waiting) return;
    clearTimeout(waiting.timer); pending.delete(item.id);
    item.error ? waiting.reject(Error(JSON.stringify(item.error))) : waiting.resolve(item.result);
  });
  await until(() => evaluate(`(()=>{const w=${windowExpr};return w&&!w.webContents.isLoading()&&w.webContents.getURL()==="notebook://app/index.html";})()`));
  await until(() => ui('!!document.querySelector("#main-composer textarea")'));
  console.log("Booted isolated application", profile);
  await ui(`document.querySelector('[data-action="open-md"][data-md-id="${mdId}"]').click()`);
  await until(() => ui('!document.getElementById("md-view").hidden&&document.getElementById("md-preview").textContent.includes("Alpha")'));
  await select("Alpha"); await ui('document.getElementById("md-tools-highlight").click()');
  await until(() => ui('(async()=>{const d=(await notebook.mdOpen(' + JSON.stringify(mdId) + ')).doc;return d.marks.length===1&&!!document.querySelector("#md-preview .highlighted");})()'));
  const first = await ask("paragraph");
  await until(() => ui('!!document.querySelector("[data-action=save-selection-annotation]:enabled")', first));
  await ui('(()=>{const b=document.querySelector("[data-action=save-selection-annotation]");b.click();b.click();})()', first);
  await until(() => ui('(async()=>{const d=(await notebook.mdOpen(' + JSON.stringify(mdId) + ')).doc;return d.comments.length===2;})()'));
  assert.equal(await ui('document.querySelectorAll("[data-action=save-selection-annotation]:enabled").length', first), 0);
  const second = await ask("Beta");
  assert.notEqual(first, second);
  await until(() => ui(`!!document.querySelector('#md-history [data-chat-id="${second}"]')`));
  await ui(`document.querySelector('#md-history [data-chat-id="${first}"]').click()`);
  await until(() => ui(`document.querySelector("#md-document-conversation iframe")?.dataset.chatId===${JSON.stringify(first)}`));
  await ui(`document.querySelector('#md-history [data-chat-id="${second}"]').click()`);
  await until(() => ui(`document.querySelector("#md-document-conversation iframe")?.dataset.chatId===${JSON.stringify(second)}`));
  console.log("Verified highlights, full chats, history without annotation, and duplicate-save prevention");
  const framesBefore = await evaluate(`${windowExpr}.webContents.mainFrame.framesInSubtree.map(f=>f.frameTreeNodeId)`);
  await ui('document.querySelector("[data-md-comment=initial] .review-enlarge").click()');
  await until(() => ui('!document.getElementById("note-focus").hidden&&!!document.querySelector("#note-focus-source #md-view")&&!!document.querySelector("#note-focus-chat iframe.embedded-chat")'));
  assert.equal(await evaluate(`${requireElectron}.BrowserWindow.getAllWindows().length`), 1, "enlarging must use the common workspace, not a popup");
  assert.equal(await ui('typeof document.body.moveBefore'), "function");
  const framesAfter = await evaluate(`${windowExpr}.webContents.mainFrame.framesInSubtree.map(f=>f.frameTreeNodeId)`);
  assert.ok(framesBefore.every((id) => framesAfter.includes(id)), "moving the document must keep its existing embedded chats alive");
  await ui('document.querySelector("[data-action=close-focus]").click()');
  await until(() => ui('document.getElementById("note-focus").hidden&&!document.getElementById("md-view").hidden'));
  assert.equal(await ui('!!document.querySelector("#note-focus-source #md-view")'), false);
  console.log("Verified the main annotation focus workspace and return without reloading existing frames");
  const external = `Agent inserted a paragraph.\n\n${text}`;
  await writeFile(path, external);
  await until(() => ui('document.getElementById("md-source").value.startsWith("Agent inserted")'));
  await ui('(()=>{const s=document.getElementById("md-source");s.value=s.value.replace("Alpha", "LocalAlpha");s.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await until(() => ui('(async()=>{const d=(await notebook.reviewState("md",' + JSON.stringify(mdId) + '));return d.unsynced&&d.text.includes("LocalAlpha");})()'));
  const agent = external.replace("Alpha", "AgentAlpha"); await writeFile(path, agent);
  await until(() => ui('!document.getElementById("md-sync-warning").hidden'));
  await ui('document.getElementById("md-save").click()');
  await until(() => ui('document.getElementById("md-file-conflict").open'));
  assert.equal(await readFile(path, "utf8"), agent);
  await ui('document.getElementById("md-conflict-later").click()');
  console.log("Verified external refresh, conflict comparison and preservation of the agent's file");
  console.log("MD UI smoke test passed");
} catch (error) {
  console.error(error);
  if(ws?.readyState===WebSocket.OPEN)try{console.error(JSON.stringify(await evaluate(`(async()=>{const w=${windowExpr};return {loading:w.webContents.isLoading(),frames:await Promise.all(w.webContents.mainFrame.framesInSubtree.map(async f=>({url:f.url,dom:await f.executeJavaScript('({ready:document.readyState,status:document.getElementById("status")?.textContent,composer:!!document.querySelector("#main-composer textarea")})')})))};})()`)));}catch(e){console.error("diagnostic",e.message);}
  console.error(log.slice(-5000));
  process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({id:++sequence,method:"Runtime.evaluate",params:{expression:`${requireElectron}.app.exit(0)`}}));
    ws.close();
    await pause(150);
  }
  if (child.exitCode === null) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); }
  }
  child.stdout.destroy(); child.stderr.destroy();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
}

// Inspector sockets may outlive a terminated Windows renderer; this single-run CLI has no work
// left after cleanup and must not leave its parent terminal waiting on a debugger handshake.
await Promise.all([new Promise(r => process.stdout.write("", r)), new Promise(r => process.stderr.write("", r))]);
process.exit(process.exitCode || 0);
