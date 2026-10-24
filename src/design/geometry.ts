import polygonClipping from "polygon-clipping";
import { Matrix4, Quaternion, Euler, Vector3 } from "three";
import type { BuildingDesign, BuildingElement, GeometryIssue, XY, XYZ } from "./types";

export const EPS = 1e-6;
export function area(poly: XY[]) {
  return Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
}
export function bounds(poly: XY[]) {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function rect(x: number, y: number, w: number, h: number): XY[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}
function cross(a: XY, b: XY, c: XY) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(a: XY, b: XY, p: XY) {
  return Math.abs(cross(a, b, p)) < EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}
export function intersects(a: XY, b: XY, c: XY, d: XY) {
  const p = cross(a, b, c), q = cross(a, b, d), r = cross(c, d, a), s = cross(c, d, b);
  return (p * q < -EPS && r * s < -EPS) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function selfIntersects(poly: XY[]) {
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
    if (j === i + 1 || (i === 0 && j === poly.length - 1)) continue;
    if (intersects(poly[i], poly[(i + 1) % poly.length], poly[j], poly[(j + 1) % poly.length])) return true;
  }
  return false;
}
export function inside(point: XY, poly: XY[]) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}
export function clippingPolygon(poly: XY[]): polygonClipping.Polygon { return [poly.map(p => p.map(n => Math.round(n * 1e8) / 1e8) as XY)]; }
export function clippedArea(polys: polygonClipping.MultiPolygon) { return polys.reduce((s, p) => s + area(p[0] as XY[]) - p.slice(1).reduce((a, ring) => a + area(ring as XY[]), 0), 0); }
export function openingFits(opening: XY[], wall: XY[]) {
  try { return clippedArea(polygonClipping.difference(clippingPolygon(opening), clippingPolygon(wall))) < EPS; } catch { return false; }
}
export function overlap(a: XY[], b: XY[]) {
  try { return clippedArea(polygonClipping.intersection(clippingPolygon(a), clippingPolygon(b))); } catch { return Infinity; }
}
export function cleanRing(poly: XY[]) {
  const out = poly.filter((p, i) => i === 0 || Math.hypot(p[0] - poly[i - 1][0], p[1] - poly[i - 1][1]) > EPS);
  if (out.length > 1 && Math.hypot(out[0][0] - out.at(-1)![0], out[0][1] - out.at(-1)![1]) < EPS) out.pop();
  // Boolean intersections can leave zero-area spikes at shared mass boundaries.
  // Remove collinear vertices (including a backtrack), without changing area.
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(cross(out[(i + out.length - 1) % out.length], out[i], out[(i + 1) % out.length])) < 1e-8) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}
export function validateDesign(scene: BuildingDesign): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  const add = (code: string, ids: string[], message: string, severity: GeometryIssue["severity"] = "error") => issues.push({ code, elementIds: ids, message, severity });
  if (scene.elements.length > 500) return [{ code: "limit", elementIds: [], message: "요소는 최대 500개입니다.", severity: "error" }];
  if (!Number.isFinite(scene.size.targetWidthMm) || scene.size.targetWidthMm < 30 || scene.size.targetWidthMm > 2000) add("size", [], "목표 모형 폭은 30~2,000 mm여야 합니다.");
  if (scene.size.mode === "known-reference" && (!(scene.size.realWidthMm! > 0) || !(scene.size.scaleDenominator! > 0) || !Number.isFinite(scene.size.realWidthMm) || !Number.isFinite(scene.size.scaleDenominator) || Math.abs(scene.size.realWidthMm! / scene.size.scaleDenominator! - scene.size.targetWidthMm) > 0.01)) add("reference", [], "실제 기준 길이와 축척·목표 크기가 일치하지 않습니다.");
  const f = scene.fabrication;
  if (!scene.elements.some(e => e.kind === "wall")) add("missing-building", [], "생성된 건물 벽이 없습니다.");
  if (typeof f.material !== "string" || f.material.length > 200 || f.joinery !== "review-only" || ![f.thicknessMm, f.frameThicknessMm, f.glassThicknessMm, f.clearanceMm, f.kerfMm].every(Number.isFinite) || f.thicknessMm < 0.5 || f.thicknessMm > 10 || f.frameThicknessMm <= 0 || f.glassThicknessMm <= 0 || f.clearanceMm < 0 || f.clearanceMm > 2 || f.kerfMm < 0 || f.kerfMm > 1) add("fabrication", [], "제작 재료 두께와 여유 범위를 확인하세요.");
  const ids = new Set<string>(), valid = new Set<string>();
  for (const e of scene.elements) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(e.id) || ids.has(e.id)) add("duplicate-id", [e.id], "요소 ID가 잘못되었거나 중복됩니다.");
    ids.add(e.id);
    if (!Array.isArray(e.outline) || e.outline.length < 3 || e.outline.length > 128 || e.outline.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n) || Math.abs(n) > 10000)) || ![...e.position, ...e.rotation, e.thickness].every(Number.isFinite) || e.thickness <= 0 || e.thickness > 100 || e.position.length !== 3 || e.rotation.length !== 3 || e.position.some(n => Math.abs(n) > 10000)) {
      add("numeric", [e.id], "윤곽·배치에 유효하지 않은 수치가 있습니다."); continue;
    }
    if (selfIntersects(e.outline)) { add("self-intersection", [e.id], "윤곽이 자기 교차합니다."); continue; }
    if (area(e.outline) < 0.05) { add("degenerate", [e.id], "윤곽 면적이 너무 작습니다."); continue; }
    if (!e.evidence.length) add("missing-evidence", [e.id], "관찰·추정·설계 근거가 없습니다.");
    if (!["observed", "inferred", "designed"].includes(e.provenance)) add("provenance", [e.id], "근거 구분이 잘못되었습니다.");
    valid.add(e.id);
  }
  for (const e of scene.elements.filter(e => e.kind === "opening" && valid.has(e.id))) {
    const wall = scene.elements.find(w => w.id === e.parentId && w.kind === "wall");
    if (!wall || !valid.has(wall.id)) { add("parent", [e.id], "개구부에 유효한 부모 벽이 없습니다."); continue; }
    if (!openingFits(e.outline, wall.outline)) add("outside-opening", [e.id, wall.id], "개구부가 벽 윤곽 밖으로 벗어납니다.");
    const b = bounds(e.outline);
    if (b.width <= 2 * (0.8 + f.clearanceMm) || b.height <= 2 * (0.8 + f.clearanceMm)) add("tiny-opening", [e.id], "창틀과 조립 여유를 만들기에 개구부가 작습니다.");
    const corners = rect(b.x, b.y, b.width, b.height);
    if (e.outline.length !== 4 || e.outline.some(p => !corners.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < EPS))) add("opening-shape", [e.id], "현재 창틀 생성은 직사각형 개구부를 지원합니다.");
  }
  const openings = scene.elements.filter(e => e.kind === "opening" && valid.has(e.id));
  for (let i = 0; i < openings.length; i++) for (let j = i + 1; j < openings.length; j++) {
    if (openings[i].parentId === openings[j].parentId && overlap(openings[i].outline, openings[j].outline) > EPS) add("overlapping-openings", [openings[i].id, openings[j].id], "같은 벽의 개구부가 서로 겹칩니다.");
  }
  const panels = scene.elements.filter(e => e.kind !== "opening" && valid.has(e.id));
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
    const a = panels[i], b = panels[j];
    if (a.position.every((n, k) => Math.abs(n - b.position[k]) < EPS) && a.rotation.every((n, k) => Math.abs(n - b.rotation[k]) < EPS) && overlap(a.outline, b.outline) > EPS) add("overlapping-panels", [a.id, b.id], "동일 평면에 패널이 겹칩니다.");
  }
  return issues;
}
export function worldPoint(e: Pick<BuildingElement, "position" | "rotation">, p: XY, z = 0): XYZ {
  return new Vector3(p[0], p[1], z).applyEuler(new Euler(...e.rotation)).add(new Vector3(...e.position)).toArray();
}
export function planeFromPoints(origin: XYZ, xPoint: XYZ, yPoint: XYZ) {
  const o = new Vector3(...origin), x = new Vector3(...xPoint).sub(o).normalize(), y = new Vector3(...yPoint).sub(o).normalize();
  const normal = x.clone().cross(y).normalize(), matrix = new Matrix4().makeBasis(x, y, normal);
  const rotation = new Euler().setFromQuaternion(new Quaternion().setFromRotationMatrix(matrix));
  return { position: origin, rotation: [rotation.x, rotation.y, rotation.z] as XYZ };
}
export function modelBounds(scene: BuildingDesign) {
  const points = scene.elements.filter(e => e.kind !== "opening" && e.kind !== "base").flatMap(e => e.outline.flatMap(p => [worldPoint(e, p), worldPoint(e, p, e.thickness)]));
  if (!points.length) return { width: 0, depth: 0, height: 0, min: [0, 0, 0] as XYZ, max: [0, 0, 0] as XYZ };
  const min = [Infinity, Infinity, Infinity] as XYZ, max = [-Infinity, -Infinity, -Infinity] as XYZ;
  for (const point of points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]); }
  return { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2], min, max };
}
