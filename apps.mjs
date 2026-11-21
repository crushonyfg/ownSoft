// Which model CLIs are installed, for the 应用与账户 page.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { codexExecutable } from "./codex.mjs";
import { executable as claudeExecutable } from "./claude.mjs";
import { agyExecutable } from "./antigravity.mjs";

// Gemini CLI ships as a Node script; it runs with Electron's own Node, so no separate Node is needed.
export function geminiScript() {
  const directories = (process.env.PATH || "").split(delimiter).filter(Boolean);
  if (process.env.APPDATA) directories.unshift(join(process.env.APPDATA, "npm"));
  for (const directory of new Set(directories)) {
    const script = join(directory, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    if (existsSync(script)) return script;
  }
  throw new Error("找不到 Gemini CLI。请在普通终端运行 npm install -g @google/gemini-cli。");
}

function version(file, args, env = process.env) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000, windowsHide: true, env }, (error, stdout) => {
      resolve(error ? "" : String(stdout).trim().split(/\r?\n/).at(-1).slice(0, 60));
    });
  });
}

async function probe(locate, args, env) {
  try {
    const path = locate();
    const [file, ...prefix] = Array.isArray(path) ? path : [path];
    return { found: true, path: prefix.at(-1) || file, version: await version(file, [...prefix, ...args], env) };
  } catch (error) {
    return { found: false, error: error.message };
  }
}

export async function appsInfo() {
  const node = [process.execPath];
  const asNode = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const [gpt, claude, gemini, legacy] = await Promise.all([
    probe(codexExecutable, ["--version"]),
    probe(claudeExecutable, ["--version"]),
    probe(agyExecutable, ["--version"]),
    probe(() => [...node, geminiScript()], ["--version"], asNode)
  ]);
  return [
    { provider: "gpt", title: "GPT", cli: "Codex CLI", ...gpt },
    { provider: "claude", title: "Claude", cli: "Claude Code", ...claude },
    { provider: "gemini", title: "Gemini", cli: "Antigravity CLI", multiAccount: false, ...gemini,
      note: [gemini.found ? "" : "安装：在普通 PowerShell 运行 irm https://antigravity.google/cli/install.ps1 | iex，然后点账户的「登录」。",
        "Antigravity 用本机这一个 Google 登录（存在系统凭据里），不能像 GPT/Claude 那样加多个账户。无界面模式不支持图片，图片不会发给 Gemini。",
        legacy.found ? "已装的 Gemini CLI 不再支持个人 Google 账户，所以这里改用 Antigravity。" : ""].filter(Boolean).join("") }
  ];
}
