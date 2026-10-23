export type XY = [number, number];
export type XYZ = [number, number, number];
export type Provenance = "observed" | "inferred" | "designed";
export type Rect = { x: number; y: number; width: number; height: number };
export type Evidence = {
  classification: Provenance;
  sourceId?: string;
  page?: number;
  region?: Rect;
  coordinateSpace?: "image-px";
  observation: string;
  reason: string;
  uncertainty: "low" | "medium" | "high";
  alternatives: string[];
  links: string[];
};
export type BuildingElement = {
  id: string;
  name: string;
  kind: "wall" | "roof" | "opening" | "detail" | "base";
  parentId?: string;
  role?: "window" | "door" | "vent";
  outline: XY[];
  position: XYZ;
  rotation: XYZ;
  thickness: number;
  material: string;
  color: string;
  provenance: Provenance;
  evidence: Evidence[];
  locked: boolean;
  userConfirmed: boolean;
  measured: boolean;
};
export type SizeSettings = {
  mode: "target-width" | "known-reference" | "assumed-real";
  targetWidthMm: number;
  realWidthMm?: number;
  scaleDenominator?: number;
};
export type FabricationSettings = {
  material: string;
  thicknessMm: number;
  frameThicknessMm: number;
  glassThicknessMm: number;
  clearanceMm: number;
  kerfMm: number;
  joinery: "review-only";
};
export type SourceObservation = {
  sourceId: string;
  page?: number;
  pixelWidth: number;
  pixelHeight: number;
  crop: Rect;
  projection: "orthographic" | "perspective" | "concept";
  view: "front";
  rectified: boolean;
  silhouette: XY[];
  openings: Array<{ role: "window" | "door" | "vent"; bounds: Rect }>;
  warnings: string[];
};
export type Comparison = {
  method: "front-silhouette-projection";
  silhouetteIoU: number;
  openingCount: number;
  openingMeanErrorMm?: number;
  evaluatedView: "front";
  independentVerification: false;
  unverifiedViews: string[];
  note: string;
};
export type DesignRun = {
  id: string;
  engine: "local-image-estimator" | "chatgpt-plan" | "separate-api" | "test-fixture";
  state: "running" | "completed-with-review" | "failed" | "cancelled" | "limited";
  startedAt: string;
  finishedAt?: string;
  attempts: Array<{ iteration: number; issueCount: number; comparison: Comparison; changedIds: string[] }>;
  requestCount: number;
  maxRequests: number;
  maxIterations: number;
  elapsedMs: number;
  actualAiCompleted: boolean;
  search: "not-connected" | "not-used" | "used-with-sources";
  warnings: string[];
  error?: string;
};
export type BuildingDesign = {
  schema: "tradiative.building.v2";
  revision: number;
  createdAt: string;
  size: SizeSettings;
  fabrication: FabricationSettings;
  elements: BuildingElement[];
  observations: SourceObservation[];
  assumptions: Evidence[];
  limitations: string[];
  run?: DesignRun;
};
export type DesignSnapshot = { at: string; label: string; design: BuildingDesign };
export type GeometryIssue = { code: string; elementIds: string[]; message: string; severity: "error" | "review" };
export type EstimateOptions = {
  sourceId: string;
  page?: number;
  size: SizeSettings;
  fabrication: FabricationSettings;
  crop?: Rect;
  projection: SourceObservation["projection"];
  completion: "visible-only" | "conservative" | "complete";
  depthRatio: number;
  maxIterations: number;
  maxDurationMs: number;
};
export type PixelImage = { width: number; height: number; data: Uint8ClampedArray };
export const DEFAULT_FABRICATION: FabricationSettings = {
  material: "검토용 판재",
  thicknessMm: 1.5,
  frameThicknessMm: 1,
  glassThicknessMm: 0.3,
  clearanceMm: 0.2,
  kerfMm: 0.15,
  joinery: "review-only",
};
export const PROVENANCE_LABELS: Record<Provenance, string> = { observed: "관찰", inferred: "추정", designed: "설계 보완" };
