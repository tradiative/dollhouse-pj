import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import DxfParser from "dxf-parser";
import {
  buildParts,
  DEFAULT_DIMENSIONS,
  dxfDrawing,
  geometryFor,
  geometryIssues,
  manifest,
  parseDimensions,
  sampleProject,
  signature,
  stlAssembly,
  stlPart,
  svgDrawing,
  validateProject,
} from "../src/engine";

test("1:80 conversion creates consistent external wall dimensions and material thickness", () => {
  const parts = buildParts(DEFAULT_DIMENSIONS);
  assert.equal(parts.length, 34);
  assert.equal(parts.filter((p) => p.group === "wall").length, 4);
  assert.equal(parts.filter((p) => p.group === "glass").length, 13);
  const wall = parts.find((p) => p.id === "W-01")!;
  assert.equal(Math.max(...wall.outline.map((p) => p[0])), 160);
  assert.equal(Math.max(...wall.outline.map((p) => p[1])), 45);
  assert.equal(wall.thickness, 1.5);
  const smaller = buildParts({ ...DEFAULT_DIMENSIONS, scale: 160 });
  assert.equal(Math.max(...smaller[0].outline.map((p) => p[0])), 80);
  assert.equal(smaller[0].thickness, 1.5);
});
test("roof halves slope in opposite directions and meet at the ridge", () => {
  const roof = buildParts(DEFAULT_DIMENSIONS).filter((p) => p.group === "roof");
  const boxes = roof.map((p) => {
    const mesh = new THREE.Mesh(geometryFor(p));
    mesh.position.set(...p.position);
    mesh.rotation.set(...p.rotation);
    mesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(mesh);
    mesh.geometry.dispose();
    return box;
  });
  assert.ok(boxes[0].max.z > 45);
  assert.ok(boxes[1].min.z < -45);
  assert.ok(boxes[0].min.z <= 0);
  assert.ok(boxes[1].max.z >= 0);
  assert.ok(Math.abs(boxes[0].max.y - boxes[1].max.y) < 0.001);
});
test("STL parts have paired triangle edges, closed outlines and no degenerate triangles", () => {
  for (const part of buildParts(DEFAULT_DIMENSIONS)) {
    const g = geometryFor(part);
    const pos = g.getAttribute("position");
    const edges = new Map<string, number>();
    const vertex = (i: number) =>
      [pos.getX(i), pos.getY(i), pos.getZ(i)]
        .map((v) => v.toFixed(4))
        .join(",");
    for (let i = 0; i < pos.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(pos, i),
        b = new THREE.Vector3().fromBufferAttribute(pos, i + 1),
        c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
      assert.ok(
        new THREE.Vector3()
          .crossVectors(b.clone().sub(a), c.clone().sub(a))
          .length() > 0.00001,
        `${part.id} degenerate triangle`,
      );
      for (const [j, k] of [
        [i, i + 1],
        [i + 1, i + 2],
        [i + 2, i],
      ]) {
        const key = [vertex(j), vertex(k)].sort().join("|");
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    assert.ok(
      [...edges.values()].every((n) => n === 2),
      `${part.id} nonmanifold/open mesh`,
    );
    g.dispose();
  }
});
test("invalid openings and nonfinite dimensions are blocked, never exported as fabricated geometry", () => {
  const invalid = { ...DEFAULT_DIMENSIONS, windowWidth: 10000 };
  assert.ok(geometryIssues(invalid).length);
  assert.equal(buildParts(invalid).length, 0);
  assert.equal(buildParts({ ...DEFAULT_DIMENSIONS, scale: 0 }).length, 0);
  assert.equal(buildParts({ ...DEFAULT_DIMENSIONS, width: NaN }).length, 0);
});
test("exports use mm, closed DXF polylines, part identifiers, and explicit review status", () => {
  const p = sampleProject(),
    parts = buildParts(p.dimensions);
  const svg = svgDrawing(parts, p.dimensions);
  assert.match(svg, /width="420mm"/);
  assert.match(svg, /REVIEW ONLY/);
  assert.match(svg, /W-01/);
  const dxf = dxfDrawing(parts);
  assert.match(dxf, /\$INSUNITS\n70\n4/);
  assert.match(dxf, /LWPOLYLINE/);
  assert.match(dxf, /70\n1/);
  const parsed = new DxfParser().parseSync(dxf)!;
  assert.equal(parsed.header.$INSUNITS, 4);
  assert.equal(parsed.header.$ACADVER, "AC1015");
  assert.ok(parsed.entities.length >= parts.length);
  assert.ok(parsed.entities.every((e) => e.type === "LWPOLYLINE"));
  const stl = stlPart(parts[0]);
  assert.match(stl, /facet normal/);
  assert.match(stl, /endsolid/);
  assert.match(stlAssembly(parts), /facet normal/);
  assert.equal(manifest(p).status, "검토용");
});
test("changes invalidate generation and missing source/physical evidence is never auto approved", () => {
  const p = sampleProject();
  assert.equal(validateProject(p).filter((c) => c.status === "pass").length, 2);
  p.generatedSignature = signature(p.dimensions);
  assert.equal(
    validateProject(p).find((c) => c.id === "generation")!.status,
    "pass",
  );
  p.dimensions = { ...p.dimensions, width: 13000 };
  assert.equal(
    validateProject(p).find((c) => c.id === "generation")!.status,
    "review",
  );
  p.physicalConfirmed = true;
  p.physicalNote = "";
  assert.equal(
    validateProject(p).find((c) => c.id === "fit")!.status,
    "review",
  );
});
test("text import reads explicit real dimensions only, including _mm aliases", () => {
  assert.deepEqual(
    parseDimensions(
      "width,12800\ndepth_mm:7200\n벽높이=3600 mm\nunknown,999\nscale,80",
    ),
    { width: 12800, depth: 7200, wallHeight: 3600 },
  );
  assert.deepEqual(
    parseDimensions("a photograph of a building 100 pixels wide"),
    {},
  );
});
test("image bytes and transient URLs never enter the portable project manifest", () => {
  const p = sampleProject();
  p.sources.push({
    id: "photo",
    name: "photo.png",
    type: "image/png",
    size: 10,
    url: "blob:private",
    text: "data:image/png;base64,c2VjcmV0",
  });
  const serialized = JSON.stringify(manifest(p));
  assert.ok(!serialized.includes("blob:private"));
  assert.ok(!serialized.includes("c2VjcmV0"));
});
