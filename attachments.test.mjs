import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  // Files go to the model as paths (PDFs with their text extracted once); only images attached to
  // this very question are also sent as pictures.
  const prepared = await store.provide(items, new AbortController().signal, { inline: [items[2]] });
  try {
    assert.deepEqual(prepared.files.map(({ name, kind, pages }) => [name, kind, pages]),
      [["text.pdf", "pdf", 1], ["visual.pdf", "pdf", 1], ["image.png", "image", undefined]]);
    assert.match(await readFile(prepared.files[0].textPath, "utf8"), /第 1 页[\s\S]+Original PDF text/);
    assert.match(await readFile(prepared.files[1].textPath, "utf8"), /没有可抽取的文字/);
    assert.deepEqual(prepared.images.map((image) => image.name), ["image.png"]);
    assert.ok(prepared.dirs.includes(join(directory, "saved")));
  } finally {
    await prepared.dispose();
  }
  assert.deepEqual(await readdir(work), []);
  // The extracted text is kept, so a second question does not read the PDF again.
  const again = await store.provide(items.slice(0, 1), new AbortController().signal);
  assert.equal(again.files[0].textPath, prepared.files[0].textPath);
});

test("pasted images without a file path are staged from their bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "notebook-paste-test-"));
  const store = new AttachmentStore(join(directory, "saved"), join(directory, "work"));
  await store.initialize([]);
  const canvas = createCanvas(8, 8);
  const png = new Uint8Array(await canvas.encode("png"));
  const { items, errors } = await store.stage([{ name: "截图 2026-11-21.png", data: png },
    { name: "假图片.png", data: new TextEncoder().encode("not a png") }], 6);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "截图 2026-11-21.png");
  assert.match(errors[0], /格式不匹配/);
  assert.deepEqual(await readdir(join(directory, "saved")), [items[0].id + ".png"]);
});
