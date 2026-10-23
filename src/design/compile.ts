import polygonClipping from "polygon-clipping";
import type { Part } from "../engine";
import type { BuildingDesign, BuildingElement, XY } from "./types";
import { bounds, cleanRing, clippingPolygon, rect, validateDesign, worldPoint } from "./geometry";

function part(e: BuildingElement, id: string, outline: XY[], holes: XY[][] = []): Part {
  const box = bounds(outline);
  return {
    id, name: e.name,
    group: e.kind === "roof" ? "roof" : e.kind === "base" ? "base" : e.kind === "detail" ? "window" : "wall",
    outline: outline.map(p => [p[0] - box.x, p[1] - box.y]),
    holes: holes.map(ring => ring.map(p => [p[0] - box.x, p[1] - box.y])),
    position: worldPoint(e, [box.x, box.y]),
    rotation: [...e.rotation],
    thickness: e.thickness,
    material: e.material, color: e.color,
    sourceElementId: e.id,
    provenance: e.provenance,
  };
}
/** The returned, immutable part list feeds the canvas and every manufacturing export. */
export function compileDesign(scene: BuildingDesign): Part[] {
  if (validateDesign(scene).some(i => i.severity === "error")) return [];
  const parts: Part[] = [];
  for (const e of scene.elements.filter(e => e.kind !== "opening")) {
    const openings = scene.elements.filter(o => o.kind === "opening" && o.parentId === e.id);
    const polygons = openings.length
      ? polygonClipping.difference(clippingPolygon(e.outline), ...openings.map(o => clippingPolygon(o.outline)))
      : [clippingPolygon(e.outline)];
    polygons.forEach((poly, i) => {
      const outline = cleanRing(poly[0] as XY[]), holes = poly.slice(1).map(ring => cleanRing(ring as XY[]));
      parts.push(part(e, e.id + (polygons.length > 1 ? "-piece-" + (i + 1) : ""), outline, holes));
    });
    for (const o of openings) {
      const b = bounds(o.outline), c = scene.fabrication.clearanceMm;
      const w = b.width - 2 * c, h = b.height - 2 * c, border = Math.min(0.8, w * 0.15, h * 0.15);
      const frame = part({ ...o, kind: "detail", name: o.name + " 프레임", thickness: scene.fabrication.frameThicknessMm,
        position: worldPoint(e, [b.x + c, b.y + c], e.thickness - scene.fabrication.frameThicknessMm),
        rotation: [...e.rotation], material: scene.fabrication.material, color: "#e8e2d4" },
        o.id + "-frame", rect(0, 0, w, h), [rect(border, border, w - 2 * border, h - 2 * border)]);
      frame.group = "window";
      parts.push(frame);
      if (o.role !== "vent") {
        const glass = part({ ...o, kind: "detail", name: o.name + " 투명판", thickness: scene.fabrication.glassThicknessMm,
          position: worldPoint(e, [b.x + c + border, b.y + c + border], e.thickness * 0.4),
          rotation: [...e.rotation], material: "검토용 투명판", color: "#8eafb5" },
          o.id + "-glass", rect(0, 0, w - 2 * border, h - 2 * border));
        glass.group = "glass";
        parts.push(glass);
      }
    }
  }
  return parts;
}
