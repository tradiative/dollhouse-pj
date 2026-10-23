import type { BuildingDesign, BuildingElement, DesignSnapshot, XY } from "./types";
import { bounds, validateDesign } from "./geometry";

export function designSignature(scene: BuildingDesign) {
  return JSON.stringify({ elements: scene.elements, fabrication: scene.fabrication, size: scene.size });
}
export function snapshot(scene: BuildingDesign, label: string): DesignSnapshot {
  return { at: new Date().toISOString(), label, design: structuredClone(scene) };
}
export function protectedIds(scene: BuildingDesign) {
  const ids = new Set(scene.elements.filter(e => e.locked).map(e => e.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of scene.elements) if (ids.has(e.id) && e.parentId && !ids.has(e.parentId)) { ids.add(e.parentId); changed = true; }
  }
  return ids;
}
export function mergeLockedDesign(previous: BuildingDesign, next: BuildingDesign): BuildingDesign {
  const locked = protectedIds(previous);
  const scene = structuredClone(next);
  for (const e of previous.elements.filter(e => locked.has(e.id))) {
    const index = scene.elements.findIndex(n => n.id === e.id);
    if (index < 0) scene.elements.push(structuredClone(e));
    else scene.elements[index] = structuredClone(e);
  }
  scene.revision = previous.revision + 1;
  return scene;
}
export function editElement(scene: BuildingDesign, id: string, change: { dx?: number; dy?: number; worldDy?: number; width?: number; height?: number; locked?: boolean; userConfirmed?: boolean; role?: BuildingElement["role"] }, reason: string) {
  const next = structuredClone(scene), e = next.elements.find(e => e.id === id);
  if (!e) throw new Error("수정할 요소를 선택하세요.");
  const geometryChange = ["dx", "dy", "worldDy", "width", "height", "role"].some(k => k in change);
  if (geometryChange && protectedIds(scene).has(id)) throw new Error("잠긴 요소 또는 잠긴 자식의 부모는 변경하지 않습니다.");
  if (Object.values(change).some(v => typeof v === "number" && (!Number.isFinite(v) || Math.abs(v) > 2000))) throw new Error("수정 값의 범위를 확인하세요.");
  if (change.locked !== undefined) e.locked = change.locked;
  if (change.userConfirmed !== undefined) e.userConfirmed = change.userConfirmed;
  if (change.role) e.role = change.role;
  if (geometryChange) {
    if (change.worldDy !== undefined) e.position[1] += change.worldDy;
    const b = bounds(e.outline);
    const sx = change.width === undefined ? 1 : change.width / b.width, sy = change.height === undefined ? 1 : change.height / b.height;
    if (!(sx > 0 && sy > 0)) throw new Error("너비와 높이는 0보다 커야 합니다.");
    e.outline = e.outline.map(p => [b.x + (p[0] - b.x) * sx + (change.dx || 0), b.y + (p[1] - b.y) * sy + (change.dy || 0)] as XY);
    e.userConfirmed = false;
    e.measured = false;
    e.evidence.push({ classification: "designed", observation: "사용자 요소 수정", reason: reason.slice(0, 500), uncertainty: "medium", alternatives: [], links: [] });
  }
  next.revision++;
  const errors = validateDesign(next).filter(i => i.severity === "error");
  if (errors.length) throw new Error(errors[0].message);
  return next;
}
export function applyInstruction(scene: BuildingDesign, id: string, text: string) {
  const e = scene.elements.find(e => e.id === id);
  if (!e) throw new Error("수정할 요소를 먼저 선택하세요.");
  const amount = Number(text.match(/(\d+(?:\.\d+)?)\s*mm/i)?.[1] || 2);
  const b = bounds(e.outline);
  if (/오른쪽/.test(text)) return editElement(scene, id, { dx: amount }, text);
  if (/왼쪽/.test(text)) return editElement(scene, id, { dx: -amount }, text);
  if (/낮춰|낮게|아래/.test(text)) return editElement(scene, id, e.kind === "roof" ? { worldDy: -amount } : e.kind === "opening" ? { dy: -amount } : { height: b.height - amount }, text);
  if (/높여|높게|위로/.test(text)) return editElement(scene, id, e.kind === "roof" ? { worldDy: amount } : e.kind === "opening" ? { dy: amount } : { height: b.height + amount }, text);
  throw new Error("현재 선택 요소의 ‘오른쪽/왼쪽으로 2mm’, ‘높여줘/낮춰줘’를 지원합니다. 해석하지 못한 요청은 적용하지 않았습니다.");
}
