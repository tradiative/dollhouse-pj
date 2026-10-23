import type { BuildingDesign, EstimateOptions, PixelImage } from "./types";
export function estimateInWorker(image: PixelImage, options: EstimateOptions, previous: BuildingDesign | undefined, signal: AbortSignal, onProgress: (scene: BuildingDesign) => void) {
  return new Promise<BuildingDesign>((resolve, reject) => {
    const worker = new Worker(new URL("./imageWorker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const stop = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { if (!settled) { settled = true; stop(); reject(new DOMException("사용자가 작업을 취소했습니다.", "AbortError")); } };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => { if (!settled) { settled = true; stop(); reject(new Error("작업 시간 한도에 도달했습니다. 저장된 최선의 결과를 확인하세요.")); } }, options.maxDurationMs + 3000);
    worker.onmessage = event => {
      if (settled) return;
      if (event.data.type === "progress") { onProgress(event.data.design); return; }
      settled = true; clearTimeout(timer); stop();
      if (event.data.type === "result") resolve(event.data.design);
      else reject(new Error(event.data.error));
    };
    worker.onerror = error => { if (!settled) { settled = true; clearTimeout(timer); stop(); reject(new Error(error.message || "이미지 작업자를 실행하지 못했습니다.")); } };
    worker.postMessage({ image, options, previous }, [image.data.buffer]);
  });
}
export async function imagePixels(blob: Blob): Promise<PixelImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width > 30000 || bitmap.height > 30000) throw new Error("이미지 변 길이는 30,000 픽셀 이하로 준비해 주세요.");
    const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(16, Math.round(bitmap.width * scale)), height = Math.max(16, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("이미지 픽셀을 읽지 못했습니다.");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height); ctx.drawImage(bitmap, 0, 0, width, height);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  } finally { bitmap.close(); }
}
