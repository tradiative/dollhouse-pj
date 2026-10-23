import type { BuildingDesign, BuildingElement } from "./types";
import { validateDesign } from "./geometry";

/** Never execute generated code, nor accept an AI's claim of user/measurement verification. */
export function parseBuildingDesign(input: unknown, fromAi = false, allowGeometryIssues = false): BuildingDesign {
  if (!input || typeof input !== "object" || JSON.stringify(input).length > 2_000_000) throw new Error("형상 데이터 크기 또는 형식이 잘못되었습니다.");
  const p = structuredClone(input) as BuildingDesign;
  if (p.schema !== "tradiative.building.v2" || !p.size || !p.fabrication || !Array.isArray(p.elements) || !Array.isArray(p.observations) || !Array.isArray(p.assumptions) || !Array.isArray(p.limitations) || !Number.isInteger(p.revision) || p.revision < 0) throw new Error("지원되는 건물 형식이 아닙니다.");
  if (!["target-width", "known-reference", "assumed-real"].includes(p.size.mode)) throw new Error("크기 설정이 잘못되었습니다.");
  if (p.limitations.some(v => typeof v !== "string" || v.length > 4000) || p.limitations.length > 100 || p.assumptions.length > 100 || p.observations.length > 100) throw new Error("근거·제약의 크기 제한을 확인하세요.");
  for (const e of p.elements) {
    if (!e || typeof e !== "object" || !["wall", "roof", "opening", "detail", "base"].includes(e.kind) || typeof e.id !== "string" || typeof e.name !== "string" || e.name.length > 200 || typeof e.material !== "string" || e.material.length > 200 || typeof e.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(e.color) || !Array.isArray(e.outline) || !Array.isArray(e.position) || !Array.isArray(e.rotation) || !Array.isArray(e.evidence) || e.evidence.length > 50) throw new Error("요소 형식이 잘못되었습니다.");
    if (e.outline.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== "number" || !Number.isFinite(n))) || [...e.position, ...e.rotation, e.thickness].some(n => typeof n !== "number" || !Number.isFinite(n))) throw new Error("요소 좌표가 유효한 수치가 아닙니다.");
    if (e.kind === "opening" && (!e.parentId || !["window", "door", "vent"].includes(e.role || ""))) throw new Error("개구부의 부모 또는 종류가 잘못되었습니다.");
    for (const proof of e.evidence) {
      if (!proof || !["observed", "inferred", "designed"].includes(proof.classification) || typeof proof.observation !== "string" || typeof proof.reason !== "string" || proof.observation.length > 4000 || proof.reason.length > 4000 || !Array.isArray(proof.links) || !Array.isArray(proof.alternatives) || !["low", "medium", "high"].includes(proof.uncertainty)) throw new Error("근거 형식이 잘못되었습니다.");
      if (proof.links.some(url => typeof url !== "string" || !/^https?:\/\//.test(url))) throw new Error("근거 링크가 잘못되었습니다.");
      if (proof.region && (![proof.region.x, proof.region.y, proof.region.width, proof.region.height].every(Number.isFinite) || proof.region.width < 0 || proof.region.height < 0)) throw new Error("근거 이미지 영역이 잘못되었습니다.");
    }
    if (fromAi) { e.locked = false; e.userConfirmed = false; e.measured = false; }
    else { e.locked = e.locked === true; e.userConfirmed = e.userConfirmed === true; e.measured = e.measured === true; }
  }
  for (const o of p.observations) {
    if (!o || typeof o.sourceId !== "string" || !Number.isFinite(o.pixelWidth) || !Number.isFinite(o.pixelHeight) || o.pixelWidth <= 0 || o.pixelHeight <= 0 || !o.crop || ![o.crop.x, o.crop.y, o.crop.width, o.crop.height].every(Number.isFinite) || !Array.isArray(o.silhouette) || !Array.isArray(o.openings) || !["orthographic", "perspective", "concept"].includes(o.projection)) throw new Error("원본 이미지 좌표 정보가 잘못되었습니다.");
    if (o.silhouette.length > 128 || o.silhouette.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n))) || !Array.isArray(o.warnings) || o.warnings.some(w => typeof w !== "string")) throw new Error("원본 관찰 윤곽이 잘못되었습니다.");
    if (o.pixelWidth > 30000 || o.pixelHeight > 30000 || o.crop.x < 0 || o.crop.y < 0 || o.crop.width < 2 || o.crop.height < 2 || o.crop.x + o.crop.width > o.pixelWidth || o.crop.y + o.crop.height > o.pixelHeight) throw new Error("원본 분석 영역이 이미지 범위를 벗어납니다.");
  }
  const errors = validateDesign(p).filter(i => i.severity === "error");
  const blocking = allowGeometryIssues ? errors.filter(i => ["numeric", "limit", "size", "reference", "fabrication", "duplicate-id"].includes(i.code)) : errors;
  if (blocking.length) throw new Error(blocking.map(i => i.message).slice(0, 3).join(" "));
  if (fromAi) delete p.run;
  return p;
}
export function resetVerification(elements: BuildingElement[]) {
  return elements.map(e => ({ ...e, userConfirmed: false, measured: false }));
}
