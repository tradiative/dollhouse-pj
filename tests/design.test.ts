import { test } from "node:test";
import assert from "node:assert/strict";
import DxfParser from "dxf-parser";
import { compareFront, estimateDesign, repairDesign } from "../src/design/estimate";
import { compileDesign } from "../src/design/compile";
import { bounds, modelBounds, rect, validateDesign, worldPoint } from "../src/design/geometry";
import { applyInstruction, editElement, mergeLockedDesign, snapshot } from "../src/design/editing";
import { parseBuildingDesign } from "../src/design/parse";
import { parseProjectMetadata } from "../src/design/archive";
import { DEFAULT_DIMENSIONS, dxfDrawing, geometryFor, manifest, projectParts, projectSignature, sampleProject, stlAssembly, svgDrawing, validateProject } from "../src/engine";
import { fixtureImage, fixtureOptions } from "./helpers/imageFixture";

const make = (n = 2, profile: "gable" | "cross" | "flat" = "gable") => estimateDesign(fixtureImage(n, profile), fixtureOptions());
test("actual pixel inputs with two/four windows produce different opening layouts and part counts", () => {
  const a = make(2), b = make(4);
  const visible = (s: typeof a) => s.elements.filter(e => e.kind === "opening" && e.provenance === "observed");
  assert.equal(visible(a).length, 2); assert.equal(visible(b).length, 4);
  assert.notDeepEqual(visible(a).map(e => e.outline), visible(b).map(e => e.outline));
  assert.equal(compileDesign(b).length - compileDesign(a).length, 8);
  assert.ok(compileDesign(a).length !== 34);
});
test("multiple roof peaks and a flat roof remain different shapes rather than the fixed house", () => {
  const cross = make(2, "cross"), flat = make(2, "flat");
  assert.ok(cross.elements.filter(e => e.kind === "roof").length > flat.elements.filter(e => e.kind === "roof").length);
  assert.ok(cross.elements.find(e => e.kind === "wall")!.outline.length > 5);
  assert.deepEqual(validateDesign(cross), []); assert.deepEqual(validateDesign(flat), []);
});
test("dimensionless image preserves target model width and never claims measured 1:80", () => {
  const s = make(), box = modelBounds(s);
  assert.ok(Math.abs(box.width - 300) < 0.001); assert.equal(s.size.mode, "target-width");
  assert.equal(s.size.realWidthMm, undefined); assert.equal(s.size.scaleDenominator, undefined);
  assert.ok(s.elements.every(e => !e.measured && !e.userConfirmed));
  const svg = svgDrawing(compileDesign(s), DEFAULT_DIMENSIONS, s.size);
  assert.ok(svg.includes("실물 축척 미확인")); assert.ok(!svg.includes("1:80"));
  assert.equal(s.fabrication.thicknessMm, 1.5);
});
test("known reference scales model geometry once without scaling the purchased material", () => {
  const options = fixtureOptions();
  options.size = { mode: "known-reference", realWidthMm: 17140, scaleDenominator: 80, targetWidthMm: 17140 / 80 };
  const s = estimateDesign(fixtureImage(), options);
  assert.ok(Math.abs(modelBounds(s).width - 214.25) < 0.001);
  assert.equal(s.fabrication.thicknessMm, 1.5);
});
test("image-pixel evidence, model-mm geometry, and unobserved completion stay separate", () => {
  const s = make(), seen = s.elements.find(e => e.kind === "opening" && e.provenance === "observed")!;
  assert.equal(seen.evidence[0].coordinateSpace, "image-px"); assert.equal(seen.evidence[0].sourceId, "test-reference");
  assert.ok(seen.evidence[0].region!.width > 0);
  assert.ok(s.elements.some(e => e.kind === "opening" && e.provenance === "designed"));
  assert.ok(s.observations[0].warnings.some(w => w.includes("외부 자료")));
  assert.equal(s.run!.actualAiCompleted, false);
  assert.equal(s.run!.attempts[0].comparison.independentVerification, false);
});
test("one opening edit leaves another locked opening and its world position unchanged; undo snapshot is exact", () => {
  let s = make();
  const openings = s.elements.filter(e => e.kind === "opening" && e.provenance === "observed");
  s = editElement(s, openings[1].id, { locked: true }, "사용자 잠금");
  const before = snapshot(s, "수정 전"), locked = structuredClone(s.elements.find(e => e.id === openings[1].id)!);
  const changed = applyInstruction(s, openings[0].id, "오른쪽으로 2mm");
  assert.deepEqual(changed.elements.find(e => e.id === locked.id), locked);
  assert.deepEqual(worldPoint(changed.elements.find(e => e.id === locked.parentId)!, locked.outline[0]), worldPoint(s.elements.find(e => e.id === locked.parentId)!, locked.outline[0]));
  assert.equal(bounds(changed.elements.find(e => e.id === openings[0].id)!.outline).x, bounds(openings[0].outline).x + 2);
  assert.throws(() => applyInstruction(changed, locked.id, "왼쪽으로 2mm"), /잠긴/);
  assert.deepEqual(before.design, s);
  const merged = mergeLockedDesign(s, make(4));
  assert.deepEqual(merged.elements.find(e => e.id === locked.id), locked);
  assert.deepEqual(merged.elements.find(e => e.id === locked.parentId), s.elements.find(e => e.id === locked.parentId));
});
test("geometry guards detect self-intersection, outside/overlapping openings, duplicate IDs and nonfinite numbers", () => {
  const cases = [
    ["self-intersection", (s: ReturnType<typeof make>) => { s.elements[0].outline = [[0,0],[20,20],[0,20],[20,0]]; }],
    ["duplicate-id", (s: ReturnType<typeof make>) => { s.elements[1].id = s.elements[0].id; }],
    ["numeric", (s: ReturnType<typeof make>) => { s.elements[0].position[0] = NaN; }],
    ["outside-opening", (s: ReturnType<typeof make>) => { s.elements.find(e => e.kind === "opening")!.outline = rect(-5,10,20,30); }],
    ["overlapping-openings", (s: ReturnType<typeof make>) => { const list = s.elements.filter(e => e.kind === "opening" && e.provenance === "observed"); list[1].outline = structuredClone(list[0].outline); }],
    ["overlapping-panels", (s: ReturnType<typeof make>) => { const duplicate = structuredClone(s.elements[0]); duplicate.id = "overlap"; s.elements.push(duplicate); }],
  ] as const;
  for (const [code, mutate] of cases) {
    const s = make(); mutate(s);
    assert.ok(validateDesign(s).some(i => i.code === code), code);
    assert.equal(compileDesign(s).length, 0);
  }
});
test("automatic repair is local to an out-of-wall opening and respects its lock", () => {
  const s = make(), opening = s.elements.find(e => e.kind === "opening" && e.provenance === "observed")!;
  opening.outline = rect(-1, 20, 15, 30);
  const other = structuredClone(s.elements.find(e => e.kind === "roof"));
  const result = repairDesign(s);
  assert.deepEqual(result.changedIds, [opening.id]); assert.deepEqual(result.scene.elements.find(e => e.kind === "roof"), other);
  assert.ok(!validateDesign(result.scene).some(i => i.code === "outside-opening"));
  opening.locked = true;
  assert.deepEqual(repairDesign(s).changedIds, []);
});
test("new model canvas parts, SVG IDs, DXF layers and STL are generated from the same scene", () => {
  const s = make(), p = { ...sampleProject(), design: s }, parts = projectParts(p);
  assert.deepEqual(parts, compileDesign(s));
  const svg = svgDrawing(parts, p.dimensions, s.size), dxf = new DxfParser().parseSync(dxfDrawing(parts))!;
  assert.equal(dxf.header.$INSUNITS, 4);
  for (const part of parts) { assert.ok(svg.includes(part.id)); assert.ok(dxf.entities.some(e => e.layer === part.id)); }
  assert.equal(manifest(p).schema, "tradiative.project.v2"); assert.equal(manifest(p).parts.length, parts.length);
  const stl = stlAssembly(parts); assert.ok(stl.includes("facet normal")); assert.ok(stl.endsWith("endsolid exported\n") || stl.includes("endsolid"));
  p.generatedSignature = projectSignature(p);
  assert.equal(validateProject(p).find(c => c.id === "generation")!.status, "pass");
  p.design = applyInstruction(s, s.elements.find(e => e.kind === "opening")!.id, "오른쪽으로 2mm");
  assert.equal(validateProject(p).find(c => c.id === "generation")!.status, "review");
});
test("new polygon-cut panel meshes have paired triangle edges", () => {
  for (const part of compileDesign(make())) {
    const g = geometryFor(part), pos = g.getAttribute("position"), edges = new Map<string, number>();
    const vertex = (i: number) => [pos.getX(i),pos.getY(i),pos.getZ(i)].map(n => n.toFixed(4)).join(",");
    for (let i = 0; i < pos.count; i += 3) for (const [a,b] of [[i,i+1],[i+1,i+2],[i+2,i]]) {
      const key = [vertex(a),vertex(b)].sort().join("|"); edges.set(key,(edges.get(key)||0)+1);
    }
    assert.ok([...edges.values()].every(n => n === 2), part.id); g.dispose();
  }
});
test("v1 metadata migrates without losing dimensions or source metadata; v2 keeps evidence and edit history", () => {
  const legacy = sampleProject(), migrated = parseProjectMetadata(manifest(legacy));
  assert.deepEqual(migrated.dimensions, legacy.dimensions); assert.equal(migrated.sources.length, legacy.sources.length);
  const s = make(), p = { ...legacy, design: s, designHistory: [snapshot(s,"중간 결과")] };
  const restored = parseProjectMetadata(JSON.parse(JSON.stringify(manifest(p))));
  assert.deepEqual(restored.design, JSON.parse(JSON.stringify(s))); assert.equal(restored.designHistory!.length, 1); assert.equal(restored.confirmed, false);
});
test("AI outputs cannot mark elements as user-confirmed, measured or locked", () => {
  const s = make();
  s.elements.forEach(e => { e.userConfirmed = true; e.measured = true; e.locked = true; });
  const parsed = parseBuildingDesign(s, true);
  assert.ok(parsed.elements.every(e => !e.userConfirmed && !e.measured && !e.locked));
});
test("lowering a selected roof changes world height rather than shortening the roof depth", () => {
  const s = make(), roof = s.elements.find(e => e.kind === "roof")!;
  const next = applyInstruction(s, roof.id, "사진처럼 지붕을 2mm 낮춰줘"), edited = next.elements.find(e => e.id === roof.id)!;
  assert.equal(edited.position[1], roof.position[1] - 2);
  assert.deepEqual(edited.outline, roof.outline);
  assert.deepEqual(next.elements.filter(e => e.id !== roof.id), s.elements.filter(e => e.id !== roof.id));
});
test("source comparison detects an opening shift without fitting the edited model back into the source", () => {
  const s = make(), id = s.elements.find(e => e.kind === "opening" && e.provenance === "observed")!.id;
  const shifted = applyInstruction(s, id, "오른쪽으로 4mm");
  assert.ok(compareFront(shifted).openingMeanErrorMm! > compareFront(s).openingMeanErrorMm! + 1.9);
  const front = s.elements.find(e => e.kind === "wall")!;
  const narrowed = editElement(s, front.id, { width: bounds(front.outline).width * 0.98 }, "외곽 비교 검사");
  assert.ok(compareFront(narrowed).silhouetteIoU < compareFront(s).silhouetteIoU);
});
test("iteration/request limits terminate and blank inputs never return a successful sample house", () => {
  const o = fixtureOptions(); o.maxIterations = 999;
  const s = estimateDesign(fixtureImage(), o);
  assert.ok(s.run!.attempts.length <= 5); assert.equal(s.run!.requestCount, 0); assert.equal(s.run!.maxRequests, 0);
  assert.equal(s.run!.actualAiCompleted, false); assert.equal(s.run!.search, "not-connected");
  assert.throws(() => estimateDesign({ width: 200, height: 100, data: new Uint8ClampedArray(80000).fill(255) }, fixtureOptions()), /윤곽/);
});
