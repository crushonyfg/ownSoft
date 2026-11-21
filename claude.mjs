import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { buildPrompt } from "./codex.mjs";

function executable() {
  if (process.platform !== "win32") return "claude";
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  paths.unshift(join(homedir(), ".local", "bin"));
  const found = paths.map((path) => join(path, "claude.exe")).find(existsSync);
  if (!found) throw new Error("找不到官方 Claude Code CLI。");
  return found;
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

  #spawn(args) {
    return spawn(executable(), args, {
      cwd: this.directory, env: this.#env(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
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

  async answer(input, { signal, update, model, effort }) {
    const prompt = buildPrompt(input);
    if (!(await this.account()).signedIn) throw new Error("请先用 Claude 订阅登录 Claude Code。");
    signal.throwIfAborted();
    if (!modelCatalog.some((item) => item.id === (model || ""))) throw new Error("未知的 Claude 模型。");
    if (effort && !effortLevels.includes(effort)) throw new Error("此 Claude Effort 不可用。");
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--no-session-persistence", "--strict-mcp-config", "--tools", "",
      "--setting-sources", "", "--permission-mode", "dontAsk",
      "--settings", '{"disableAllHooks":true}'
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
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
      const child = this.#spawn(args);
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let output = "";
      let result;
      let timedOut = false;
      let stderr = "";
      const cancel = () => child.kill();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; cancel(); }, 180_000);
      child.stderr.setEncoding("utf8").on("data", (text) => { stderr = (stderr + text).slice(-1600); });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "result") result = event;
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
          resolve((result?.result || output).trim());
        } else {
          reject(new Error("Claude 没有返回文本。"));
        }
      });
      child.stdin.end(stdin);
    });
  }
}
