import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { buildPrompt } from "./codex.mjs";

export function executable() {
  if (process.platform !== "win32") return "claude";
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  paths.unshift(join(homedir(), ".local", "bin"));
  const found = paths.map((path) => join(path, "claude.exe")).find(existsSync);
  if (!found) throw new Error("找不到官方 Claude Code CLI。");
  return found;
}

// A tool call's arguments in a line, e.g. "C:\…\paper.txt 120 80" for Read(file_path, offset, limit).
export function toolDetail(input) {
  if (!input || typeof input !== "object") return "";
  return Object.values(input).filter((value) => typeof value === "string" || typeof value === "number")
    .map(String).join(" ").replace(/\s+/g, " ").slice(0, 300);
}

const effortLevels = ["low", "medium", "high", "xhigh", "max"];
const modelCatalog = [
  ["", "Claude 默认"],
  ["sonnet", "Claude Sonnet"],
  ["opus", "Claude Opus"],
  ["haiku", "Claude Haiku"]
].map(([id, label]) => ({ id, label, isDefault: !id, efforts: effortLevels }));

export class Claude {
  #login;

  constructor(directory, configDirectory) {
    this.directory = directory;
    this.configDirectory = configDirectory;
  }

  #env() {
    const exclude = new Set([
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_MODEL",
      ...(this.configDirectory ? ["CLAUDE_CONFIG_DIR"] : [])
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !exclude.has(key.toUpperCase())));
    if (this.configDirectory) env.CLAUDE_CONFIG_DIR = this.configDirectory;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    return env;
  }

  #spawn(args, cwd = this.directory) {
    return spawn(executable(), args, {
      cwd, env: this.#env(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
  }

  account() {
    return new Promise((resolve, reject) => {
      const child = this.#spawn(["auth", "status", "--json"]);
      const timer = setTimeout(() => child.kill(), 20_000);
      let text = "";
      child.stdin.end();
      child.stdout.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(text);
          const signedIn = status.loggedIn === true && status.authMethod === "claude.ai" &&
            (!status.apiProvider || status.apiProvider === "firstParty");
          resolve({ signedIn, plan: signedIn ? status.subscriptionType ?? "" : "",
            email: signedIn ? status.email ?? "" : "" });
        } catch {
          reject(new Error("无法检查 Claude Code 登录状态。"));
        }
      });
    });
  }

  async models() {
    return modelCatalog;
  }

  async login() {
    if (this.#login) return this.#login;
    const command = executable();
    const env = this.#env();
    let child;
    if (process.platform === "win32") {
      // The native CLI owns the interactive login, including manual code entry if needed.
      env.NOTEBOOK_CLAUDE_EXECUTABLE = command;
      const script = "$ErrorActionPreference='Stop'; $p = Start-Process -FilePath $env:NOTEBOOK_CLAUDE_EXECUTABLE -ArgumentList @('auth','login','--claudeai') -PassThru; $p.WaitForExit(); exit $p.ExitCode";
      const shellPath = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      child = spawn(shellPath, ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        cwd: this.directory, env, windowsHide: true, stdio: "ignore"
      });
    } else {
      child = spawn(command, ["auth", "login", "--claudeai"], { cwd: this.directory, env, stdio: "inherit" });
    }
    this.#login = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Claude Code 登录未完成，请重试。"));
      });
    }).finally(() => { this.#login = undefined; });
    return this.#login;
  }

  async answer(input, { signal, update, activity = () => {}, tool = () => {}, usage = () => {}, limits = () => {},
    model, effort, cwd, resumeSession, persistSession = false }) {
    const resumed = Boolean(resumeSession && persistSession);
    const prompt = buildPrompt(resumed ? { ...input, history: [], context: "", memories: [],
      files: input.files.filter((file) => file.current) } : input);
    if (!(await this.account()).signedIn) throw new Error("请先用 Claude 订阅登录 Claude Code。");
    signal.throwIfAborted();
    if (!modelCatalog.some((item) => item.id === (model || ""))) throw new Error("未知的 Claude 模型。");
    if (effort && !effortLevels.includes(effort)) throw new Error("此 Claude Effort 不可用。");
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--strict-mcp-config", "--tools", "default",
      "--setting-sources", "", "--permission-mode", "auto",
      "--settings", '{"disableAllHooks":true}'
    ];
    const sessionId = resumed ? resumeSession : randomUUID();
    if (persistSession) args.push(resumed ? "--resume" : "--session-id", sessionId);
    else args.push("--no-session-persistence");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Attached files are read from the app's attachment folders.
    for (const dir of input.dirs || []) args.push("--add-dir", dir);
    let stdin = prompt;
    if (input.images?.length) {
      const content = [{ type: "text", text: prompt }];
      for (const image of input.images) {
        signal.throwIfAborted();
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: await readFile(image.path, "base64") }
        });
      }
      args.push("--input-format", "stream-json");
      stdin = JSON.stringify({
        type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: ""
      }) + "\n";
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = this.#spawn(args, cwd || this.directory);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let output = "";
      let result;
      let timedOut = false;
      let stderr = "";
      const cancel = () => child.kill();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; cancel(); }, 600_000);
      child.stderr.setEncoding("utf8").on("data", (text) => { stderr = (stderr + text).slice(-1600); });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "result") {
          result = event;
          const counts = event.usage || {};
          usage({
            inputTokens: (counts.input_tokens || 0) + (counts.cache_read_input_tokens || 0) +
              (counts.cache_creation_input_tokens || 0),
            outputTokens: counts.output_tokens || 0
          });
        }
        // Claude Code reports its subscription limit only as a status, with a percentage when close.
        if (event.type === "rate_limit_event" && event.rate_limit_info) {
          const info = event.rate_limit_info;
          const reset = Number(info.resetsAt ?? info.resets_at);
          const kind = String(info.rateLimitType ?? info.rate_limit_type ?? "limit");
          const labels = { five_hour: "5 小时", seven_day: "每周", seven_day_opus: "每周 · Opus", seven_day_sonnet: "每周 · Sonnet" };
          const utilization = Number(info.utilization);
          limits([{ key: kind, label: labels[kind] || kind, status: String(info.status || ""),
            usedPercent: Number.isFinite(utilization) ? Math.round(utilization <= 1 ? utilization * 100 : utilization) : null,
            resetsAt: reset ? (reset < 1e12 ? reset * 1000 : reset) : null, observed: Date.now() }]);
        }
        const block = event.type === "stream_event" && event.event?.content_block;
        if (block?.type === "tool_use" && block.name) {
          activity(`正在使用 ${block.name}`);
          tool({ id: block.id || `claude:${event.event.index}`, title: block.name,
            detail: "", status: "running" });
        }
        // The finished tool call carries its arguments (which file, which pages, what was searched).
        if (event.type === "assistant") {
          for (const item of event.message?.content || []) {
            if (item.type === "tool_use" && item.id) tool({ id: item.id, title: item.name, detail: toolDetail(item.input) });
          }
        }
        if (event.type === "user") {
          for (const item of event.message?.content || []) {
            if (item.type === "tool_result" && item.tool_use_id) {
              tool({ id: item.tool_use_id, status: item.is_error ? "failed" : "done", result: item.content });
            }
          }
        }
        const delta = event.type === "stream_event" && event.event?.delta;
        if (delta?.type === "text_delta") {
          output += delta.text;
          update(output);
        }
      });
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
        if (signal.aborted) reject(new Error("已停止生成。"));
        else if (timedOut) reject(new Error("Claude 生成超时。"));
        else if (code !== 0 || result?.is_error) {
          reject(new Error(result?.result || result?.errors?.join(" ") || stderr.trim() || "Claude 生成失败。"));
        } else if ((result?.result || output).trim()) {
          resolve({ text: (result?.result || output).trim(),
            sessionId: persistSession ? result?.session_id || sessionId : undefined });
        } else {
          reject(new Error("Claude 没有返回文本。"));
        }
      });
      child.stdin.end(stdin);
    });
  }
}
