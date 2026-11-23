import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { maxPromptChars } from "./context-budget.mjs";
import { codexMcpConfig } from "./mcp-configuration.mjs";

export function codexExecutable() {
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
  const bundled = desktopCodex();
  if (bundled) return bundled;
  throw new Error("找不到 Codex CLI。安装 Codex 桌面版或官方 Codex CLI 后，再打开此应用。");
}

// Without a standalone CLI, use the codex.exe that ships inside the Codex desktop app (a Store
// package, whose install folder Windows only reveals through Get-AppxPackage). Looked up once.
let desktopLookup;
function desktopCodex() {
  if (desktopLookup !== undefined) return desktopLookup;
  desktopLookup = null;
  try {
    const shell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const location = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
    { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
    const candidate = location && join(location, "app", "resources", "codex.exe");
    if (candidate && existsSync(candidate)) desktopLookup = candidate;
  } catch {}
  return desktopLookup;
}

const options = [
  'model_provider="openai"', 'forced_login_method="chatgpt"',
  'web_search="live"',
  "features.apps=false", "features.plugins=false", "features.hooks=false",
  "features.memories=false", "skills.include_instructions=false"
].flatMap((option) => ["-c", option]);

// In the group chat each model is told who it is and who else is present; earlier answers in the
// history are prefixed with the speaker, e.g. 【gpt1】.
function personaSection({ name, provider, others = [], round = [], role = "" }) {
  const position = round.indexOf(name);
  return [role ? `你的角色设定（始终按它回答，优先于下面的一般说明）：\n${role}\n\n` : "",
    `你是群聊里的成员「${name}」（${provider}）。`,
    others.length ? `群里还有：${others.join("、")}。用户用 @名字 指定谁回答。` : "",
    round.length > 1 ? `这次提问点名了 ${round.join("、")}，按这个顺序依次回答，你是第 ${position + 1} 位` +
      (position > 0 ? "，前面成员的回答在下面" : "，后面的成员会接着回答") +
      "。只回答提问里给你的部分，不要替其他成员回答或评价他们还没说的话。" : "",
    "历史里以【成员名】开头的回答是那位成员说的；没有标注的旧回答来自之前的模型，不一定是你说的。",
    "直接回答，不要在开头写自己的名字。"].filter(Boolean).join("");
}

// Attached files are listed with their paths; the model opens what it needs with its own tools.
function filesSection(files) {
  const lines = files.map((file, index) => {
    if (file.kind === "missing") return `${index + 1}. 「${file.name}」：本地文件已不存在`;
    if (file.kind === "image") {
      return `${index + 1}. 图片「${file.name}」：${file.path}${file.current ? "（本次提问随附，已直接发给你看）" : ""}`;
    }
    return [`${index + 1}. PDF「${file.name}」，${file.pages} 页${file.subject ? "（这次对话讨论的就是这份 PDF）" : ""}` +
      `${file.current ? "（本次提问随附）" : ""}`,
      `   原文件：${file.path}`,
      `   抽取好的文字（按页标注「===== 第 N 页 =====」，约 ${file.chars} 字）：${file.textPath}`].join("\n");
  });
  return "附件文件（在本机。需要时用你的读文件工具打开，可以只读相关的页；能直接读 PDF 的可以读原文件看图表，" +
    "否则读抽取好的文字。回答时说明依据的是第几页。）\n" + lines.join("\n");
}

export function buildPrompt({ context, memories, history, question, files = [], images = [], persona, peers = "", notebookId }) {
  const sections = [];
  if (persona) sections.push("你的身份\n" + personaSection(persona));
  if (notebookId && persona?.provider !== "Gemini") sections.push(`当前 AI 笔记本会话 ID：${notebookId}。` +
    "需要追查局部引句以外的消息、工具依据或关联 Markdown 时，按需调用 ownsoft 的 search_library、read_chat、read_message、read_markdown；不要猜测未读取的内容。" +
    "用户要求保存成果或修改批注时，可用相应的 ownsoft 写入工具。笔记内的 ownsoft://chat/… 和 ownsoft://md/… 链接可按 ID 继续追溯。");
  if (history.length) sections.push("已有对话\n" + JSON.stringify(history));
  if (peers) sections.push("本轮其他成员已经回答了同一个问题\n" + peers);
  if (context) sections.push("笔记上下文\n" + context);
  if (memories.length) sections.push("我选入的记忆\n" + memories.map((text, index) => `${index + 1}. ${text}`).join("\n"));
  if (files.length) sections.push(filesSection(files));
  if (images.length) sections.push("随附图片的顺序\n" + images.map(({ name }, index) => `${index + 1}. ${name}`).join("\n"));
  const text = sections.length ? [...sections, "本次提问\n" + question].join("\n\n") : question;
  if (text.length > maxPromptChars) {
    throw new Error("这次的对话历史太长。请开启新分支，或在「主对话上下文」里只选需要的消息。");
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

  constructor(directory, configDirectory, approve, dataDir) {
    super();
    this.directory = directory;
    this.configDirectory = configDirectory;
    this.approve = approve;
    this.dataDir = dataDir;
  }

  async connect() {
    if (this.#ready) return this.#ready;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
        ...(this.configDirectory ? ["CODEX_HOME", "CODEX_SQLITE_HOME"] : [])].includes(key.toUpperCase())));
    if (this.configDirectory) env.CODEX_HOME = this.configDirectory;
    const profileOptions = this.configDirectory ? ["-c", 'cli_auth_credentials_store="file"'] : [];
    const child = spawn(codexExecutable(), ["app-server", "--listen", "stdio://", ...options,
      "-c", codexMcpConfig(this.dataDir), ...profileOptions], {
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
      const approvals = new Set([
        "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
        "item/permissions/requestApproval"
      ]);
      if (!approvals.has(message.method)) {
        if (child.stdin.writable) this.#write({ id: message.id,
          error: { code: -32601, message: "This request is not supported by the notebook." } });
        return;
      }
      void Promise.resolve().then(() => this.approve?.(message.method, message.params))
        .then((result) => {
          if (child === this.#child && child.stdin.writable) this.#write({ id: message.id,
            result: result || (message.method === "item/permissions/requestApproval"
              ? { permissions: {}, scope: "turn" } : { decision: "decline" }) });
        }).catch(() => {
          if (child === this.#child && child.stdin.writable) this.#write({ id: message.id,
            result: message.method === "item/permissions/requestApproval"
              ? { permissions: {}, scope: "turn" } : { decision: "decline" } });
        });
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

  // The ChatGPT plan's usage windows (5-hour and weekly), as percentages used.
  async rateLimits() {
    await this.connect();
    const result = await this.#request("account/rateLimits/read", undefined);
    const limits = result?.rateLimits ?? result;
    const label = (window, fallback) => {
      const minutes = Number(window.windowDurationMins);
      if (minutes === 300) return "5 小时";
      if (minutes === 10080) return "每周";
      return minutes ? (minutes % 1440 ? `${Math.round(minutes / 60)} 小时` : `${minutes / 1440} 天`) : fallback;
    };
    return [[limits?.primary, "短期"], [limits?.secondary, "长期"]].filter(([window]) => window).map(([window, fallback]) => {
      const reset = Number(window.resetsAt ?? window.resetAt);
      return { key: fallback, label: label(window, fallback), usedPercent: Number(window.usedPercent),
        resetsAt: reset ? (reset < 1e12 ? reset * 1000 : reset) : null };
    });
  }

  async answer(payload, { signal, update, activity = () => {}, tool = () => {}, usage = () => {},
    model: selectedModel, effort, cwd, resumeSession, persistSession = false }) {
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
    const resumed = Boolean(resumeSession && persistSession);
    const { thread } = resumed
      ? await this.#request("thread/resume", { threadId: resumeSession, excludeTurns: true })
      : await this.#request("thread/start", {
        cwd: cwd || this.directory, ephemeral: !persistSession,
        sandbox: "workspace-write", approvalPolicy: "on-request", model: model.id
      });
    try {
      signal.throwIfAborted();
      let text = buildPrompt(resumed ? { ...payload, history: [], context: "", memories: [],
        files: payload.files.filter((file) => file.current) } : payload);
      const items = resumed ? [] : nativeHistory(payload.history);
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
      const answer = await this.#turn(thread.id, input, { signal, update, activity, tool, usage,
        effort: effort || model.defaultEffort });
      return { text: answer, sessionId: persistSession ? thread.id : undefined };
    } finally {
      if (this.#child) await this.#request("thread/unsubscribe", { threadId: thread.id }).catch(() => {});
    }
  }

  #turn(threadId, input, { signal, update, activity, tool, usage, effort }) {
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
      }, 600_000);
      add("disconnected", (error) => finish(error));
      const toolLabels = { webSearch: "搜索网页", commandExecution: "运行命令",
        fileChange: "修改文件", mcpToolCall: "调用外部工具",
        imageView: "查看图片", collabToolCall: "调用助手" };
      const reportTool = (params, status) => {
        if (params.threadId !== threadId || !toolLabels[params.item?.type]) return;
        const item = params.item;
        const detail = item.query || item.command || item.tool || item.name || item.path || "";
        tool({ id: item.id || `${item.type}:${detail}`, title: toolLabels[item.type], detail, status,
          ...(status === "done" ? { result: item } : {}) });
      };
      add("item/started", (params) => {
        if (params.threadId !== threadId) return;
        if (toolLabels[params.item?.type]) activity(`正在${toolLabels[params.item.type]}`);
        reportTool(params, "running");
      });
      add("item/completed", (params) => reportTool(params,
        params.item?.status === "failed" ? "failed" : "done"));
      add("item/started", record);
      add("item/completed", record);
      add("thread/tokenUsage/updated", (params) => {
        if (params.threadId !== threadId) return;
        const counts = params.tokenUsage?.total ?? params.tokenUsage?.last;
        if (counts) usage({ inputTokens: counts.inputTokens, outputTokens: counts.outputTokens });
      });
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
