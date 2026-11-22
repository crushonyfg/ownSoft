import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "notebook-mcp.mjs");

export function ownsoftMcp(dataDir) {
  if (!dataDir) return null;
  return { command: process.execPath, args: [serverPath],
    env: { ELECTRON_RUN_AS_NODE: "1", AI_NOTEBOOK_DATA_DIR: dataDir } };
}

// TOML basic strings and arrays use the same escaping as these JSON literals.
export function codexMcpConfig(dataDir) {
  const server = ownsoftMcp(dataDir);
  if (!server) return 'mcp_servers={}';
  return `mcp_servers={ownsoft={command=${JSON.stringify(server.command)},` +
    `args=[${server.args.map((arg) => JSON.stringify(arg)).join(",")}],` +
    `env={ELECTRON_RUN_AS_NODE="1",AI_NOTEBOOK_DATA_DIR=${JSON.stringify(dataDir)}}}}`;
}
