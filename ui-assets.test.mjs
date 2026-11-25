import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiAssets, fileAsset } from "./ui-assets.mjs";

test("an app instance keeps a complete matching UI version while source files change", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ownsoft-ui-assets-"));
  await writeFile(join(folder, "index.html"), "old page");
  await writeFile(join(folder, "app.mjs"), "old code");
  const serve = await uiAssets(folder, new Map([["/index.html", "index.html"], ["/app.mjs", "app.mjs"]]));
  await writeFile(join(folder, "app.mjs"), "new code requiring a different backend");
  assert.equal(await serve("/app.mjs").text(), "old code");
  assert.equal(await serve("/app.mjs").text(), "old code", "each iframe gets a fresh readable response");
  assert.equal(serve("/app.mjs").headers.get("Content-Type"), "text/javascript");
  assert.equal(serve("/missing").status, 404);
});

test("local fonts and images are served directly with their MIME types", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ownsoft-font-assets-"));
  const file = join(folder, "font.woff2");
  await writeFile(file, Buffer.from([1, 2, 3]));
  const response = await fileAsset(file);
  assert.equal(response.headers.get("Content-Type"), "font/woff2");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1, 2, 3]));
  assert.equal((await fileAsset(join(folder, "missing.woff2"))).status, 404);
});
