export async function pdfPageImage(file: Blob, pageNumber: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("PDF 작업 취소", "AbortError");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, maxImageSize: 16_777_216 });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise;
    if (signal?.aborted) throw new DOMException("PDF 작업 취소", "AbortError");
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) throw new Error("PDF 페이지는 1~" + document.numPages + "에서 선택하세요.");
    const page = await document.getPage(pageNumber), initial = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(initial.width, initial.height)) });
    const canvas = window.document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PDF 페이지를 이미지로 처리하지 못했습니다.");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PDF 이미지 생성 실패")), "image/png"));
    return { blob, pageCount: document.numPages };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("PDF 작업 취소", "AbortError");
    throw error;
  } finally { signal?.removeEventListener("abort", abort); await task.destroy().catch(() => {}); }
}
