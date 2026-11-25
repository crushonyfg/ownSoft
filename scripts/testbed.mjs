import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { exportTestbed, prepareTestbed } from "../portable-data.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift();
const option = key => { const at = args.indexOf(key); return at < 0 ? null : args[at+1]; };
const archive = resolve(option("--archive") || join(root, "testbeds", "current-notes.zip"));
const target = resolve(option("--target") || join(root, ".testbed-data", "current-notes"));
try {
  if (command === "export") {
    const source = option("--source");
    if (!source) throw new Error("导出需要 --source <当前数据目录>");
    const summary = exportTestbed(resolve(source), archive);
    writeFileSync(join(dirname(archive), "manifest.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "prepare" || command === "start") {
    if (command === "prepare" || !existsSync(join(target, "notebook.sqlite")))
      console.log(prepareTestbed(archive, target));
    if (command === "start") {
      console.log(`Testbed 数据目录：${target}`);
      const { default: electron } = await import("electron");
      const child = spawn(electron, [root], { cwd: root, stdio: "inherit", windowsHide: true,
        env: { ...process.env, AI_NOTEBOOK_DATA_DIR: target } });
      child.on("error", error => { console.error(error.message); process.exitCode = 1; });
      child.on("exit", code => { process.exitCode = code || 0; });
    }
  } else throw new Error("用法：node scripts/testbed.mjs export|prepare|start [--source 路径] [--target 路径] [--archive ZIP]");
} catch (error) { console.error(error.message); process.exitCode = 1; }
