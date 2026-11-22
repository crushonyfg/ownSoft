// Gemini through Google's Antigravity CLI (`agy`), which replaced Gemini CLI for personal Google
// accounts. Headless runs read one stream-json user message from stdin (prompts can be longer than
// a Windows command line allows) and print NDJSON events: init, step_update…, result.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { buildPrompt } from "./codex.mjs";

export function agyExecutable() {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const directories = (process.env.PATH || "").split(delimiter).filter(Boolean);
  if (process.env.LOCALAPPDATA) directories.unshift(join(process.env.LOCALAPPDATA, "agy", "bin"));
  if (process.env.HOME || process.env.USERPROFILE) directories.push(join(process.env.HOME || process.env.USERPROFILE, ".local", "bin"));
  for (const directory of new Set(directories)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 Antigravity CLI（agy）。请在普通终端安装后重新打开应用。");
}

const effortLevels = ["low", "medium", "high", "xhigh", "max"];

export function parseQuota(text) {
  const windows = { "Five Hour Limit Remaining": "5 小时", "Weekly Limit Remaining": "每周" };
  const groups = { "Gemini Models": "Gemini 模型", "Claude and GPT models": "Claude/GPT 模型" };
  return text.split(/\r?\n/).flatMap((line) => {
    const [group, window, remaining, reset] = line.split("\t").map((part) => part.trim());
    const left = Number.parseFloat(remaining);
    if (!group || !window || !Number.isFinite(left)) return [];
    const time = Date.parse(reset);
    return [{ key: `${group}:${window}`, label: `${groups[group] || group} · ${windows[window] || window}`,
      usedPercent: Math.max(0, Math.min(100, 100 - left)), resetsAt: Number.isFinite(time) ? time : null }];
  });
}

function run(args, { cwd, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(agyExecutable(), args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }))
        : resolve({ stdout: String(stdout), stderr: String(stderr) }));
  });
}

const authProblem = (text) => /authentication required|not (?:logged|signed) in|login required|unauthenticated/i.test(text);

export class Antigravity {
  #models;
  #login;

  constructor(directory) {
    this.directory = directory;
  }

  // agy has no status command; listing models needs a valid login, so it doubles as the check.
  async account() {
    try {
      this.#models = await this.#listModels();
      return { signedIn: true, plan: "Google", email: "" };
    } catch (error) {
      const text = `${error.stderr || ""}${error.stdout || ""}${error.message}`;
      if (authProblem(text)) return { signedIn: false };
      if (error.code === "ENOENT" || /找不到 Antigravity/.test(error.message)) throw error;
      return { signedIn: false, message: "登录状态未知" };
    }
  }

  async #listModels() {
    const { stdout } = await run(["models"], { cwd: this.directory });
    const models = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      // "gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)"
      const match = /^([a-z0-9][a-z0-9._-]*)\s+(.+)$/i.exec(line);
      return match ? [{ id: match[1], label: match[2].trim(), efforts: effortLevels }] : [];
    });
    if (!models.length) throw Object.assign(new Error("Antigravity 没有返回模型列表。"), { stdout });
    return [{ id: "", label: "Antigravity 默认", isDefault: true, efforts: effortLevels }, ...models];
  }

  async models() {
    this.#models ??= await this.#listModels();
    return this.#models;
  }

  // Login happens in agy's own interactive screen (browser OAuth); the window closes when done.
  async login() {
    if (this.#login) return this.#login;
    const command = agyExecutable();
    let child;
    if (process.platform === "win32") {
      const script = "$p = Start-Process -FilePath $env:NOTEBOOK_AGY -PassThru; $p.WaitForExit(); exit $p.ExitCode";
      const shellPath = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      child = spawn(shellPath, ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        cwd: this.directory, env: { ...process.env, NOTEBOOK_AGY: command }, windowsHide: true, stdio: "ignore"
      });
    } else {
      child = spawn(command, [], { cwd: this.directory, stdio: "inherit" });
    }
    this.#login = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => {
        this.#models = undefined;
        resolve();
      });
    }).finally(() => { this.#login = undefined; });
    return this.#login;
  }

  // The "Models & Quota" report; agy prints it for a one-off slash command as tab-separated rows:
  // "Gemini Models<TAB>Five Hour Limit Remaining<TAB>99%<TAB>2026-11-21T14:43:52Z".
  async quota() {
    const { stdout } = await run(["-p", "/usage"], { cwd: this.directory, timeout: 45_000 });
    return { items: parseQuota(stdout), text: stdout.trim() };
  }

  async answer(input, { signal, update, activity = () => {}, tool = () => {}, usage = () => {}, model, effort, cwd }) {
    // Headless agy takes text only; images are named in the prompt but not sent.
    const skipped = input.images?.length || 0;
    const prompt = buildPrompt({ ...input, images: [] }) +
      (skipped ? `\n\n（本次随附的 ${skipped} 张图片没有直接发送：Antigravity CLI 的无界面模式不支持图片输入。需要时请按上面「附件文件」里的路径打开图片。）` : "");
    if (effort && !effortLevels.includes(effort)) throw new Error("此 Gemini Effort 不可用。");
    const args = ["-p", "", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Attached files (images included, which headless agy cannot be sent) are read from these folders.
    for (const dir of input.dirs || []) args.push("--add-dir", dir);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(agyExecutable(), args, { cwd: cwd || this.directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let output = "";
      let result;
      let stderr = "";
      let timedOut = false;
      const cancel = () => child.kill();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; cancel(); }, 600_000);
      child.stderr.setEncoding("utf8").on("data", (text) => { stderr = (stderr + text).slice(-2000); });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.event === "result") {
          result = event.result || {};
          if (result.usage) usage({ inputTokens: (result.usage.input_tokens || 0) + (result.usage.cache_read_tokens || 0),
            outputTokens: (result.usage.output_tokens || 0) + (result.usage.thinking_tokens || 0) });
          // One question per process: close stdin so agy ends the session.
          child.stdin.end();
          return;
        }
        const step = event.event === "step_update" && event.step_update;
        if (!step) return;
        if (step.step_type === "agent_response" && step.text_delta) {
          output += step.text_delta;
          update(output);
        } else if (step.step_type === "tool") {
          const name = step.tool_name || step.tool_info?.name || "工具";
          if (step.state === "ACTIVE") activity(`正在使用 ${name}`);
          const parameters = step.tool_info?.parameters;
          tool({ id: `agy:${step.step_index}`, title: name,
            detail: parameters ? Object.values(parameters).filter((value) => typeof value === "string").join(" ").slice(0, 300) : "",
            status: step.tool_info?.error ? "failed" : step.state === "DONE" ? "done" : "running" });
        }
      });
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
        const text = (result?.response || output).trim();
        if (signal.aborted) reject(new Error("已停止生成。"));
        else if (timedOut) reject(new Error("Gemini 生成超时。"));
        else if (authProblem(`${stderr} ${result?.error || ""}`)) reject(new Error("请先在「应用与账户」里登录 Antigravity（Gemini）。"));
        else if (result && result.status !== "SUCCESS") reject(new Error(result.error || `Gemini 生成失败（${result.status}）。`));
        else if (code !== 0 && !text) reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || "Gemini 生成失败。"));
        else if (text) resolve(text);
        else reject(new Error("Gemini 没有返回文本。"));
      });
      child.stdin.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
    });
  }
}
