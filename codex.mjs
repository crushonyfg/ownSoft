import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

function codexExecutable() {
  if (process.platform !== "win32") return "codex";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const target = architecture === "arm64" ? "aarch64" : "x86_64";
  const directories = (process.env.PATH || "").split(delimiter).filter(Boolean);
  if (process.env.APPDATA) directories.unshift(join(process.env.APPDATA, "npm"));
  for (const directory of new Set(directories)) {
    const direct = join(directory, "codex.exe");
    const npmRoot = join(directory, "node_modules", "@openai", "codex", "node_modules");
    const npmBinary = join(npmRoot, "@openai", `codex-win32-${architecture}`,
      "vendor", `${target}-pc-windows-msvc`, "bin", "codex.exe");
    for (const candidate of [direct, npmBinary]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("找不到 Codex CLI。安装官方 Codex CLI 后，再打开此应用。");
}

const options = [
  'model_provider="openai"', 'forced_login_method="chatgpt"',
  'web_search="disabled"', 'history.persistence="none"',
  "features.shell_tool=false", "features.shell_snapshot=false",
  "features.apps=false", "features.plugins=false", "features.hooks=false",
  "features.memories=false", "features.multi_agent=false", "features.fast_mode=false",
  "skills.include_instructions=false", "mcp_servers={}"
].flatMap((option) => ["-c", option]);

export function buildPrompt({ context, memories, history, question, documents = [], images = [] }) {
  const sections = [];
  if (history.length) sections.push("已有对话\n" + JSON.stringify(history));
  if (context) sections.push("引用的原文段落\n" + context);
  if (memories.length) sections.push("我选入的记忆\n" + memories.map((text, index) => `${index + 1}. ${text}`).join("\n"));
  if (documents.length) sections.push("PDF 正文\n" + documents.map(({ file, page, text }) =>
    `「${file}」第 ${page} 页\n${text}`).join("\n\n"));
  if (images.length) sections.push("随附图片的顺序\n" + images.map(({ name }, index) => `${index + 1}. ${name}`).join("\n"));
  const text = sections.length ? [...sections, "本次提问\n" + question].join("\n\n") : question;
  if (text.length > 160_000) {
    throw new Error("本次上下文太长。请开启新分支，或减少引用的内容。");
  }
  return text;
}

function nativeHistory(history) {
  return history.flatMap(({ question, answer }) => [
    question && { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
    answer && { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }
  ].filter(Boolean));
}

export class Codex extends EventEmitter {
  #child;
  #ready;
  #requestId = 0;
  #pending = new Map();

  constructor(directory, configDirectory) {
    super();
    this.directory = directory;
    this.configDirectory = configDirectory;
  }

  async connect() {
    if (this.#ready) return this.#ready;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
        ...(this.configDirectory ? ["CODEX_HOME", "CODEX_SQLITE_HOME"] : [])].includes(key.toUpperCase())));
    if (this.configDirectory) env.CODEX_HOME = this.configDirectory;
    const profileOptions = this.configDirectory ? ["-c", 'cli_auth_credentials_store="file"'] : [];
    const child = spawn(codexExecutable(), ["app-server", "--listen", "stdio://", ...options, ...profileOptions], {
      cwd: this.directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#read(line, child));
    child.stderr.resume();
    child.stdin.on("error", () => this.#disconnect(child));
    child.on("error", () => this.#disconnect(child));
    child.on("close", () => this.#disconnect(child));

    this.#ready = this.#request("initialize", {
      clientInfo: { name: "ai_notebook", title: "AI Notebook", version: "0.1.0" }
    }).then(() => {
      this.#write({ method: "initialized" });
    }).catch((error) => {
      this.#disconnect(child);
      throw error;
    });
    return this.#ready;
  }

  #disconnect(child) {
    if (child !== this.#child) return;
    this.#child = undefined;
    this.#ready = undefined;
    child.kill();
    const error = new Error("与 Codex 的连接已断开。请重试。");
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
    this.emit("disconnected", error);
  }

  close() {
    if (this.#child) this.#disconnect(this.#child);
  }

  #write(payload) {
    if (!this.#child?.stdin.writable) throw new Error("Codex 连接不可用。");
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #request(method, params) {
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex 响应超时（${method}）。`));
      }, 25_000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.#pending.get(id)?.reject(error);
        this.#pending.delete(id);
      }
    });
  }

  #read(line, child) {
    if (child !== this.#child) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      if (child.stdin.writable) {
        this.#write({ id: message.id, error: { code: -32601, message: "This notebook only supports text replies." } });
      }
      return;
    }
    if (message.method) {
      if (message.method !== "error") this.emit(message.method, message.params);
      return;
    }
    const request = this.#pending.get(message.id);
    if (!request) return;
    this.#pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message || "Codex 请求失败。"), { code: message.error.code }));
    else request.resolve(message.result);
  }

  async account() {
    await this.connect();
    const { account } = await this.#request("account/read", { refreshToken: false });
    return account?.type === "chatgpt"
      ? { signedIn: true, plan: account.planType ?? "", email: account.email ?? "" }
      : { signedIn: false };
  }

  async login() {
    await this.connect();
    return this.#request("account/login/start", { type: "chatgpt" });
  }

  async models() {
    await this.connect();
    const models = [];
    let cursor;
    do {
      const result = await this.#request("model/list", { cursor, includeHidden: false });
      models.push(...result.data.map((entry) => ({
        id: entry.model, label: entry.displayName || entry.model, isDefault: entry.isDefault,
        efforts: (entry.supportedReasoningEfforts || []).map((item) => item.reasoningEffort),
        defaultEffort: entry.defaultReasoningEffort, inputModalities: entry.inputModalities
      })));
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  }

  async answer(payload, { signal, update, model: selectedModel, effort }) {
    let text = buildPrompt(payload);
    const account = await this.account();
    if (!account.signedIn) throw new Error("请先用 ChatGPT 订阅登录 Codex。");
    const models = await this.models();
    const model = selectedModel ? models.find((item) => item.id === selectedModel) :
      models.find((item) => item.isDefault) || models[0];
    if (!model) throw new Error("当前订阅没有返回所选模型，请重新选择。");
    if (effort && !model.efforts.includes(effort)) throw new Error("所选模型不支持此 Effort。");
    if (payload.images?.length && model.inputModalities && !model.inputModalities.includes("image")) {
      throw new Error("所选模型不支持图片。请更换模型后再发送。");
    }
    signal.throwIfAborted();
    const { thread } = await this.#request("thread/start", {
      cwd: this.directory, ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
      model: model.id
    });
    try {
      signal.throwIfAborted();
      const items = nativeHistory(payload.history);
      if (items.length) {
        try {
          await this.#request("thread/inject_items", { threadId: thread.id, items });
          text = buildPrompt({ ...payload, history: [] });
        } catch (error) {
          if (error.code !== -32601 && !/experimentalApi capability/i.test(error.message)) throw error;
        }
      }
      signal.throwIfAborted();
      const input = [{ type: "text", text },
        ...(payload.images || []).map(({ path }) => ({ type: "localImage", path }))];
      return await this.#turn(thread.id, input, { signal, update, effort: effort || model.defaultEffort });
    } finally {
      if (this.#child) await this.#request("thread/unsubscribe", { threadId: thread.id }).catch(() => {});
    }
  }

  #turn(threadId, input, { signal, update, effort }) {
    return new Promise((resolve, reject) => {
      const messages = new Map();
      let turnId;
      let finished = false;
      const subscriptions = [];
      const add = (name, listener) => {
        this.on(name, listener);
        subscriptions.push([name, listener]);
      };
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", interrupt);
        for (const [name, listener] of subscriptions) this.off(name, listener);
        if (error) reject(error);
        else resolve(result);
      };
      const interrupt = () => {
        if (!turnId) return;
        this.#request("turn/interrupt", { threadId, turnId }).catch((error) => {
          this.close();
          finish(error);
        });
      };
      const output = () => [...messages.values()]
        .filter((item) => item.phase !== "commentary" && item.text)
        .map((item) => item.text).join("\n\n");
      const record = (params) => {
        if (params.threadId !== threadId || params.item?.type !== "agentMessage") return;
        messages.set(params.item.id, params.item);
        update(output());
      };

      const timeout = setTimeout(() => {
        finish(new Error("Codex 生成超时。可以重新发送问题。"));
        this.close();
      }, 180_000);
      add("disconnected", (error) => finish(error));
      add("item/started", record);
      add("item/completed", record);
      add("item/agentMessage/delta", (params) => {
        if (params.threadId !== threadId) return;
        const item = messages.get(params.itemId) || { text: "" };
        messages.set(params.itemId, { ...item, text: item.text + params.delta });
        update(output());
      });
      add("turn/completed", (params) => {
        if (params.threadId !== threadId) return;
        const { turn } = params;
        if (signal.aborted || turn.status === "interrupted") {
          finish(new Error("已停止生成。"));
        } else if (turn.status !== "completed") {
          finish(new Error(turn.error?.message || "Codex 生成失败。"));
        } else {
          const reply = output().trim();
          finish(reply ? null : new Error("Codex 没有返回文本。"), reply);
        }
      });
      signal.addEventListener("abort", interrupt, { once: true });
      this.#request("turn/start", {
        threadId, effort, input
      }).then(({ turn }) => {
        turnId = turn.id;
        if (!finished && signal.aborted) interrupt();
      }).catch((error) => finish(error));
    });
  }
}
