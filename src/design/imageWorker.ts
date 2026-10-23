/// <reference lib="webworker" />
import { estimateDesign } from "./estimate";
import type { BuildingDesign, EstimateOptions, PixelImage } from "./types";
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<{ image: PixelImage; options: EstimateOptions; previous?: BuildingDesign }>) => {
  try {
    const scene = estimateDesign(event.data.image, event.data.options, event.data.previous, design => worker.postMessage({ type: "progress", design }));
    worker.postMessage({ type: "result", design: scene });
  } catch (error) {
    worker.postMessage({ type: "error", error: error instanceof Error ? error.message : "이미지 추정에 실패했습니다." });
  }
};
