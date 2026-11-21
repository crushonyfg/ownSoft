import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { AttachmentStore } from "./attachments.mjs";

function pdf(content) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  return text + "xref\n0 6\n0000000000 65535 f \n" +
    offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("attachments retain text and visual PDF pages, and clean up temporary renderings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "notebook-file-test-"));
  const inputPaths = ["text.pdf", "visual.pdf", "image.png", "invalid.png"].map((name) => join(directory, name));
  const canvas = createCanvas(24, 24);
  canvas.getContext("2d").fillRect(1, 1, 12, 12);
  await Promise.all([
    writeFile(inputPaths[0], pdf("BT /F1 20 Tf 30 100 Td (Original PDF text) Tj ET\n")),
    writeFile(inputPaths[1], pdf("0.1 0.6 0.2 rg 50 50 130 70 re f\n")),
    writeFile(inputPaths[2], await canvas.encode("png")),
    writeFile(inputPaths[3], "text renamed to PNG")
  ]);
  const work = join(directory, "work");
  const store = new AttachmentStore(join(directory, "saved"), work);
  await store.initialize([]);
  const { items, errors } = await store.stage(inputPaths, 6);
  assert.equal(items.length, 3);
  assert.match(errors[0], /格式不匹配/);
  const prepared = await store.prepare(items, new AbortController().signal);
  try {
    assert.deepEqual(prepared.documents, [{ file: "text.pdf", page: 1, text: "Original PDF text" }]);
    assert.deepEqual(prepared.images.map((image) => image.name),
      ["text.pdf · 第 1 页", "visual.pdf · 第 1 页", "image.png"]);
  } finally {
    await prepared.dispose();
  }
  assert.deepEqual(await readdir(work), []);
});
