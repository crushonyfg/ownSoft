// Page previews for PDF notes in the chat. Documents load once per attachment; rendered pages are
// kept, so re-rendering the chat moves the same canvas instead of drawing it again.
let runtime;
const documents = new Map();
const pages = new Map();

async function pdfjs() {
  if (!runtime) {
    runtime = import("./pdf-runtime/build/pdf.min.mjs").then((module) => {
      module.GlobalWorkerOptions.workerSrc = new URL("./pdf-runtime/build/pdf.worker.min.mjs", location.href).href;
      return module;
    });
  }
  return runtime;
}

export function pdfDocument(refId) {
  if (!documents.has(refId)) {
    const loading = (async () => {
      const module = await pdfjs();
      const response = await fetch(`notebook://app/note-file/${refId}`);
      if (!response.ok) throw new Error("找不到这个 PDF 文件。");
      const asset = (path) => new URL(`./pdf-runtime/${path}`, location.href).href;
      return module.getDocument({
        data: new Uint8Array(await response.arrayBuffer()), isEvalSupported: false, useWorkerFetch: true,
        cMapUrl: asset("cmaps/"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts/"), wasmUrl: asset("wasm/")
      }).promise;
    })();
    loading.catch(() => documents.delete(refId));
    documents.set(refId, loading);
  }
  return documents.get(refId);
}

// Draws page `number` of the PDF into `container` at about `width` CSS pixels; returns the page count.
export async function renderPdfPage(container, refId, number, width = 420) {
  const document = await pdfDocument(refId);
  const page = Math.max(1, Math.min(document.numPages, number));
  const key = `${refId}:${page}:${Math.round(width)}`;
  let canvas = pages.get(key);
  if (!canvas) {
    const module = await pdfjs();
    const pdfPage = await document.getPage(page);
    const original = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: width / original.width });
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas = window.document.createElement("canvas");
    canvas.width = Math.round(viewport.width * ratio);
    canvas.height = Math.round(viewport.height * ratio);
    canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    canvas.setAttribute("aria-label", `PDF 第 ${page} 页`);
    await pdfPage.render({ canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      annotationMode: module.AnnotationMode.DISABLE }).promise;
    if (pages.size > 40) pages.delete(pages.keys().next().value);
    pages.set(key, canvas);
  }
  container.replaceChildren(canvas);
  return { page, total: document.numPages };
}
