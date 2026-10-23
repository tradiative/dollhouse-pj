import { inside } from "../../src/design/geometry";
import { DEFAULT_FABRICATION, type EstimateOptions, type PixelImage, type XY } from "../../src/design/types";
export function fixtureImage(windowCount = 2, profile: "gable" | "cross" | "flat" = "gable"): PixelImage {
  const width = 360, height = 250, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const top: XY[] = profile === "flat" ? [[25, 85], [335, 85]] : profile === "cross"
    ? [[25, 85], [90, 85], [130, 30], [170, 85], [245, 85], [280, 55], [315, 85], [335, 85]]
    : [[25, 85], [180, 30], [335, 85]];
  const polygon: XY[] = [[25, 225], [335, 225], ...top.slice().reverse()];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside([x, y], polygon)) data.set([205, 195, 170, 255], (y * width + x) * 4);
  for (let i = 0; i < windowCount; i++) {
    const left = Math.round(50 + i * 245 / Math.max(1, windowCount - 1));
    for (let y = 135; y < 200; y++) for (let x = left; x < left + 20; x++) data.set([35, 60, 80, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
export function fixtureOptions(): EstimateOptions {
  return { sourceId: "test-reference", size: { mode: "target-width", targetWidthMm: 300 }, fabrication: { ...DEFAULT_FABRICATION }, projection: "orthographic", completion: "complete", depthRatio: 0.35, maxIterations: 3, maxDurationMs: 15000 };
}
