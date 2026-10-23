import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

export type Dimensions = {
  width: number;
  depth: number;
  wallHeight: number;
  roofRise: number;
  windowWidth: number;
  windowHeight: number;
  doorWidth: number;
  doorHeight: number;
  scale: number;
  thickness: number;
  kerf: number;
  clearance: number;
};
export type Point = [number, number];
export type Part = {
  id: string;
  name: string;
  group: "wall" | "roof" | "window" | "glass" | "base";
  outline: Point[];
  holes: Point[][];
  thickness: number;
  position: [number, number, number];
  rotation: [number, number, number];
  color: string;
  material: string;
};
export type Source = {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  text?: string;
  sample?: boolean;
};
export type Project = {
  name: string;
  dimensions: Dimensions;
  sources: Source[];
  confirmed: boolean;
  generatedSignature: string;
  physicalConfirmed: boolean;
  physicalNote: string;
  updatedAt: string;
};
export type Check = {
  id: string;
  name: string;
  detail: string;
  status: "pass" | "review" | "fail";
};
export const DEFAULT_DIMENSIONS: Dimensions = {
  width: 12800,
  depth: 7200,
  wallHeight: 3600,
  roofRise: 2200,
  windowWidth: 1200,
  windowHeight: 1600,
  doorWidth: 1600,
  doorHeight: 2400,
  scale: 80,
  thickness: 1.5,
  kerf: 0.15,
  clearance: 0.2,
};
export function sampleProject(): Project {
  return {
    name: "임피역 본관",
    dimensions: { ...DEFAULT_DIMENSIONS },
    sources: [
      {
        id: "sample-elevation",
        name: "임피역_정면입면도.svg",
        type: "image/svg+xml",
        size: 2840,
        sample: true,
      },
      {
        id: "sample-measure",
        name: "건축물_기초치수.csv",
        type: "text/csv",
        size: 168,
        sample: true,
        text: "width,12800\ndepth,7200\nwallHeight,3600\nroofRise,2200\nwindowWidth,1200\nwindowHeight,1600",
      },
    ],
    confirmed: false,
    generatedSignature: "",
    physicalConfirmed: false,
    physicalNote: "",
    updatedAt: new Date().toISOString(),
  };
}
export function signature(d: Dimensions) {
  return JSON.stringify(
    Object.keys(DEFAULT_DIMENSIONS).map((k) => d[k as keyof Dimensions]),
  );
}
export function validDimensions(d: Dimensions) {
  return (
    Object.keys(DEFAULT_DIMENSIONS).every(
      (key) =>
        typeof d[key as keyof Dimensions] === "number" &&
        Number.isFinite(d[key as keyof Dimensions]),
    ) &&
    d.scale >= 10 &&
    d.scale <= 500 &&
    d.width > 0 &&
    d.depth > 0 &&
    d.wallHeight > 0 &&
    d.roofRise > 0 &&
    d.windowWidth > 0 &&
    d.windowHeight > 0 &&
    d.doorWidth > 0 &&
    d.doorHeight > 0 &&
    d.thickness >= 0.5 &&
    d.thickness <= 10 &&
    d.kerf >= 0 &&
    d.kerf <= 1 &&
    d.clearance >= 0 &&
    d.clearance <= 2 &&
    d.width / d.scale <= 2000 &&
    d.depth / d.scale <= 2000 &&
    (d.wallHeight + d.roofRise) / d.scale <= 2000
  );
}
export function geometryIssues(d: Dimensions): string[] {
  if (!validDimensions(d))
    return [
      "치수 범위를 확인하세요. 축척 1:10~1:500, 재료 두께 0.5~10 mm, 모형 한 변 최대 2,000 mm입니다.",
    ];
  const w = d.width / d.scale,
    dep = d.depth / d.scale,
    h = d.wallHeight / d.scale;
  const ww = d.windowWidth / d.scale,
    wh = d.windowHeight / d.scale,
    dw = d.doorWidth / d.scale;
  const issues: string[] = [];
  if (wh + h * 0.26 >= h - d.thickness)
    issues.push("창문 상단과 벽 상단의 간격이 부족합니다.");
  if (d.doorHeight / d.scale >= h - d.thickness)
    issues.push("출입문 높이가 벽 높이를 초과합니다.");
  if (ww + 2 * d.thickness >= w * 0.16)
    issues.push("정면 창문 사이에 필요한 벽 두께가 부족합니다.");
  if (dw / 2 + ww / 2 + d.thickness >= w * 0.18)
    issues.push("출입문과 가장 가까운 창문이 겹칩니다.");
  if (ww + 2 * d.thickness >= (dep - 2 * d.thickness) * 0.34)
    issues.push("측면 창문 사이에 필요한 벽 두께가 부족합니다.");
  if (Math.min(ww, wh) <= 2.4 + 2 * d.clearance)
    issues.push("창틀 내부 유효 폭이 너무 작습니다.");
  if (
    dw <= 4 + 2 * d.clearance ||
    d.doorHeight / d.scale <= Math.max(5, d.clearance / 0.08 + 1)
  )
    issues.push("출입문이 너무 작아 유효한 문틀을 생성할 수 없습니다.");
  if (d.clearance >= d.thickness)
    issues.push("조립 여유가 재료 두께보다 큽니다.");
  if (dep <= 4 * d.thickness)
    issues.push("측면 길이에 비해 재료가 너무 두껍습니다.");
  return issues;
}
const rect = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
export function buildParts(d: Dimensions): Part[] {
  if (geometryIssues(d).length) return [];
  const w = d.width / d.scale,
    dep = d.depth / d.scale,
    h = d.wallHeight / d.scale,
    rise = d.roofRise / d.scale;
  const ww = d.windowWidth / d.scale,
    wh = d.windowHeight / d.scale,
    dw = d.doorWidth / d.scale,
    dh = d.doorHeight / d.scale;
  const t = d.thickness,
    c = d.clearance,
    eave = 3;
  const parts: Part[] = [];
  const add = (p: Part) => parts.push(p);
  const wallColor = "#dfd0b2",
    roofColor = "#526256";
  const frontXs = [0.15, 0.32, 0.68, 0.85].map((x) => w * x - ww / 2);
  const backXs = [0.12, 0.31, 0.5, 0.69, 0.88].map((x) => w * x - ww / 2);
  const sideWidth = dep - 2 * t;
  const sideXs = [0.3, 0.7].map((x) => sideWidth * x - ww / 2);
  const bottom = h * 0.26;
  const frontOutline: Point[] = [
    [0, 0],
    [(w - dw) / 2, 0],
    [(w - dw) / 2, dh],
    [(w + dw) / 2, dh],
    [(w + dw) / 2, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  add({
    id: "W-01",
    name: "정면 벽체",
    group: "wall",
    outline: frontOutline,
    holes: frontXs.map((x) => rect(x, bottom, ww, wh)),
    thickness: t,
    position: [-w / 2, 0, dep / 2 - t],
    rotation: [0, 0, 0],
    color: wallColor,
    material: "자작 합판",
  });
  add({
    id: "W-02",
    name: "배면 벽체",
    group: "wall",
    outline: rect(0, 0, w, h),
    holes: backXs.map((x) => rect(x, bottom, ww, wh)),
    thickness: t,
    position: [w / 2, 0, -dep / 2 + t],
    rotation: [0, Math.PI, 0],
    color: wallColor,
    material: "자작 합판",
  });
  const sideOutline: Point[] = [
    [0, 0],
    [sideWidth, 0],
    [sideWidth, h],
    [sideWidth / 2, h + rise],
    [0, h],
  ];
  add({
    id: "W-03",
    name: "좌측 박공벽",
    group: "wall",
    outline: sideOutline,
    holes: sideXs.map((x) => rect(x, bottom, ww, wh)),
    thickness: t,
    position: [-w / 2 + t, 0, -dep / 2 + t],
    rotation: [0, -Math.PI / 2, 0],
    color: wallColor,
    material: "자작 합판",
  });
  add({
    id: "W-04",
    name: "우측 박공벽",
    group: "wall",
    outline: sideOutline,
    holes: sideXs.map((x) => rect(x, bottom, ww, wh)),
    thickness: t,
    position: [w / 2 - t, 0, dep / 2 - t],
    rotation: [0, Math.PI / 2, 0],
    color: wallColor,
    material: "자작 합판",
  });
  const angle = Math.atan2(rise, dep / 2),
    slope = Math.hypot(rise, dep / 2) + eave / Math.cos(angle);
  add({
    id: "R-01",
    name: "정면 지붕판",
    group: "roof",
    outline: rect(0, 0, w + 2 * eave, slope),
    holes: [],
    thickness: t,
    position: [-w / 2 - eave, h + rise, 0],
    rotation: [Math.PI / 2 + angle, 0, 0],
    color: roofColor,
    material: "지붕용 판재",
  });
  add({
    id: "R-02",
    name: "배면 지붕판",
    group: "roof",
    outline: rect(0, 0, w + 2 * eave, slope),
    holes: [],
    thickness: t,
    position: [w / 2 + eave, h + rise, 0],
    rotation: [Math.PI / 2 - angle, 0, Math.PI],
    color: roofColor,
    material: "지붕용 판재",
  });
  add({
    id: "B-01",
    name: "기초 베이스",
    group: "base",
    outline: rect(0, 0, w + 14, dep + 14),
    holes: [],
    thickness: 2.5,
    position: [-w / 2 - 7, -2.5, dep / 2 + 7],
    rotation: [-Math.PI / 2, 0, 0],
    color: "#b5af9d",
    material: "베이스 판재",
  });
  const walls = parts.filter((p) => p.group === "wall");
  let count = 0;
  walls.forEach((wall) =>
    wall.holes.forEach((hole) => {
      count++;
      const fw = ww - 2 * c,
        fh = wh - 2 * c,
        border = 0.8,
        mid = 0.55;
      const pw = (fw - 2 * border - mid) / 2,
        ph = (fh - 2 * border - mid) / 2;
      const shapeHoles = [
        rect(border, border, pw, ph),
        rect(border + pw + mid, border, pw, ph),
        rect(border, border + ph + mid, pw, ph),
        rect(border + pw + mid, border + ph + mid, pw, ph),
      ];
      const rot = new THREE.Euler(...wall.rotation);
      const origin = new THREE.Vector3(
        hole[0][0] + c,
        hole[0][1] + c,
        wall.thickness - 0.5,
      )
        .applyEuler(rot)
        .add(new THREE.Vector3(...wall.position));
      add({
        id: `F-${String(count).padStart(2, "0")}`,
        name: `${wall.name.replace(" 벽체", "").replace(" 박공벽", "")} 창틀 ${wall.holes.indexOf(hole) + 1}`,
        group: "window",
        outline: rect(0, 0, fw, fh),
        holes: shapeHoles,
        thickness: 1,
        position: origin.toArray() as [number, number, number],
        rotation: wall.rotation,
        color: "#f4ecda",
        material: "창틀용 판재",
      });
      const glassOrigin = new THREE.Vector3(0, 0, -0.45)
        .applyEuler(rot)
        .add(origin);
      add({
        id: `G-${String(count).padStart(2, "0")}`,
        name: `투명판 ${count}`,
        group: "glass",
        outline: rect(0, 0, fw, fh),
        holes: [],
        thickness: 0.3,
        position: glassOrigin.toArray() as [number, number, number],
        rotation: wall.rotation,
        color: "#9db4ac",
        material: "투명 PET",
      });
    }),
  );
  add({
    id: "D-01",
    name: "중앙 양개문",
    group: "window",
    outline: rect(0, 0, dw - 2 * c, dh - c),
    holes: [
      rect(1, dh * 0.34, (dw - 2 * c - 3) / 2, dh * 0.58),
      rect((dw - 2 * c + 1) / 2, dh * 0.34, (dw - 2 * c - 3) / 2, dh * 0.58),
    ],
    thickness: 1,
    position: [-dw / 2 + c, 0, dep / 2 - 0.6],
    rotation: [0, 0, 0],
    color: "#796f52",
    material: "창틀용 판재",
  });
  return parts;
}
export function shapeFor(part: Part) {
  const shape = new THREE.Shape(
    part.outline.map((p) => new THREE.Vector2(...p)),
  );
  part.holes.forEach((h) =>
    shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(...p)))),
  );
  return shape;
}
export function geometryFor(part: Part) {
  const raw = new THREE.ExtrudeGeometry(shapeFor(part), {
    depth: part.thickness,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  // Earcut can bridge aligned holes with edges spanning other boundary vertices.
  // Split those T-junctions before export so each physical part is watertight.
  const positions = raw.getAttribute("position");
  const unique = new Map<string, THREE.Vector3>();
  for (let i = 0; i < positions.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(positions, i);
    unique.set(
      v
        .toArray()
        .map((n) => n.toFixed(5))
        .join(","),
      v,
    );
  }
  const vertices = [...unique.values()],
    output: number[] = [];
  for (let i = 0; i < positions.count; i += 3) {
    const triangle = [0, 1, 2].map((j) =>
      new THREE.Vector3().fromBufferAttribute(positions, i + j),
    );
    const boundary: THREE.Vector3[] = [];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j],
        b = triangle[(j + 1) % 3],
        edge = b.clone().sub(a),
        lengthSq = edge.lengthSq();
      boundary.push(a);
      const splits = vertices
        .map((v) => ({ v, t: v.clone().sub(a).dot(edge) / lengthSq }))
        .filter(
          ({ v, t }) =>
            t > 1e-6 &&
            t < 1 - 1e-6 &&
            a.clone().addScaledVector(edge, t).distanceToSquared(v) < 1e-10,
        )
        .sort((a, b) => a.t - b.t);
      boundary.push(...splits.map((s) => s.v));
    }
    if (boundary.length === 3)
      output.push(...triangle.flatMap((v) => v.toArray()));
    else {
      const center = triangle
        .reduce((sum, v) => sum.add(v), new THREE.Vector3())
        .divideScalar(3);
      boundary.forEach((v, j) =>
        output.push(
          ...center.toArray(),
          ...v.toArray(),
          ...boundary[(j + 1) % boundary.length].toArray(),
        ),
      );
    }
  }
  raw.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(output, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}
export function validateProject(p: Project): Check[] {
  const issues = geometryIssues(p.dimensions),
    generated = p.generatedSignature === signature(p.dimensions);
  return [
    {
      id: "scale",
      name: "축척·단위 일관성",
      detail: `실제 치수 mm ÷ ${p.dimensions.scale} → 모형 mm. 재료 두께는 환산하지 않습니다.`,
      status: validDimensions(p.dimensions) ? "pass" : "fail",
    },
    {
      id: "geometry",
      name: "윤곽·개구부 검사",
      detail: issues.length
        ? issues.join(" ")
        : "벽·창문·출입문 윤곽이 닫혀 있고 개구부가 벽 범위 안에 있습니다.",
      status: issues.length ? "fail" : "pass",
    },
    {
      id: "source",
      name: "원본 치수 대조",
      detail:
        p.confirmed && p.sources.length
          ? "사용자가 입력 치수의 출처와 단위를 확인했습니다."
          : "샘플·추정 치수입니다. 자료를 등록하고 원본과 비교한 뒤 설계 기준에서 확인해 주세요.",
      status: p.confirmed && p.sources.length ? "pass" : "review",
    },
    {
      id: "generation",
      name: "부품 버전 일치",
      detail: generated
        ? "현재 설계 기준으로 부품 목록을 생성했습니다."
        : "현재 기준의 부품 목록을 생성해 주세요. 치수 수정 시 다시 생성해야 합니다.",
      status: generated ? "pass" : "review",
    },
    {
      id: "fit",
      name: "재료·조립 실물 확인",
      detail:
        p.physicalConfirmed && p.physicalNote.trim()
          ? `시험 가공 기록: ${p.physicalNote}`
          : `두께 ${p.dimensions.thickness} mm · 편측 여유 ${p.dimensions.clearance} mm. 연결부 강도·휨·끼움은 실물 확인이 필요합니다.`,
      status: p.physicalConfirmed && p.physicalNote.trim() ? "pass" : "review",
    },
  ];
}
function n(v: number) {
  return Number(v.toFixed(3));
}
function xml(s: string) {
  return s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
export function layoutParts(parts: Part[]) {
  const sheetWidth = Math.max(
    420,
    ...parts.map((p) => Math.max(...p.outline.map((q) => q[0])) + 16),
  );
  let x = 8,
    y = 8,
    rowHeight = 0;
  return parts.map((p) => {
    const width = Math.max(...p.outline.map((q) => q[0])),
      height = Math.max(...p.outline.map((q) => q[1]));
    if (x + width > sheetWidth - 8) {
      x = 8;
      y += rowHeight + 13;
      rowHeight = 0;
    }
    const item = { part: p, x, y, width, height };
    x += width + 9;
    rowHeight = Math.max(rowHeight, height);
    return item;
  });
}
export function svgDrawing(parts: Part[], d: Dimensions) {
  const layout = layoutParts(parts),
    height = Math.max(80, ...layout.map((p) => p.y + p.height)) + 24;
  const sheetWidth = Math.max(
    420,
    ...parts.map((p) => Math.max(...p.outline.map((q) => q[0])) + 16),
  );
  const path = (poly: Point[]) =>
    poly.map((p, i) => `${i ? "L" : "M"}${n(p[0])},${n(p[1])}`).join(" ") +
    " Z";
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${n(sheetWidth)}mm" height="${n(height)}mm" viewBox="0 0 ${n(sheetWidth)} ${n(height)}"><title>TRADIATIVE · 1:${d.scale} · 검토용 도안</title><desc>단위 mm. 빨강: 윤곽. 파랑: 부품 번호. kerf ${d.kerf}mm 보정 미적용; 가공업체 CAM에서 재료별 분리·보정 필요.</desc>${layout.map((p) => `<g transform="translate(${n(p.x)},${n(p.y + p.height)}) scale(1,-1)"><path d="${[p.part.outline, ...p.part.holes].map(path).join(" ")}" fill="none" stroke="#b5573e" stroke-width="0.12"/></g><text x="${n(p.x)}" y="${n(p.y + p.height + 3)}" font-family="sans-serif" font-size="2.2" fill="#344b64">${p.part.id} · ${xml(p.part.name)} · ${xml(p.part.material)} · t${p.part.thickness}</text>`).join("")}<text x="8" y="${n(height - 6)}" font-family="sans-serif" font-size="3" fill="#444">TRADIATIVE / REVIEW ONLY / 1:${d.scale} / mm / kerf compensation not applied</text></svg>`;
}
export function dxfDrawing(parts: Part[]) {
  const lines = [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1015",
    "9",
    "$INSUNITS",
    "70",
    "4",
    "9",
    "$MEASUREMENT",
    "70",
    "1",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "TABLES",
    "0",
    "TABLE",
    "2",
    "LAYER",
    "70",
    String(parts.length),
  ];
  parts.forEach((p) =>
    lines.push(
      "0",
      "LAYER",
      "100",
      "AcDbSymbolTableRecord",
      "100",
      "AcDbLayerTableRecord",
      "2",
      p.id,
      "70",
      "0",
      "62",
      p.group === "glass" ? "4" : "1",
      "6",
      "CONTINUOUS",
    ),
  );
  lines.push("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
  layoutParts(parts).forEach(({ part, x, y, height }) =>
    [part.outline, ...part.holes].forEach((poly) => {
      lines.push(
        "0",
        "LWPOLYLINE",
        "100",
        "AcDbEntity",
        "8",
        part.id,
        "100",
        "AcDbPolyline",
        "90",
        String(poly.length),
        "70",
        "1",
      );
      poly.forEach((p) =>
        lines.push(
          "10",
          String(n(x + p[0])),
          "20",
          String(n(-y - height + p[1])),
        ),
      );
    }),
  );
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n") + "\n";
}
export function stlPart(part: Part) {
  const geometry = geometryFor(part),
    mesh = new THREE.Mesh(geometry);
  const result = new STLExporter().parse(mesh, { binary: false });
  geometry.dispose();
  return result;
}
export function stlAssembly(parts: Part[]) {
  const group = new THREE.Group();
  parts.forEach((p) => {
    const mesh = new THREE.Mesh(geometryFor(p));
    mesh.position.set(...p.position);
    mesh.rotation.set(...p.rotation);
    group.add(mesh);
  });
  group.rotation.x = Math.PI / 2;
  group.position.z = 2.5;
  group.updateMatrixWorld(true);
  const result = new STLExporter().parse(group, { binary: false });
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  return result;
}
export function manifest(p: Project) {
  const parts = buildParts(p.dimensions);
  return {
    schema: "tradiative.project.v1",
    status: "검토용",
    exportedAt: new Date().toISOString(),
    units: "mm",
    coordinateSystem: {
      partData:
        "right-handed Y-up, local XY outlines extruded along +Z before assembly transforms",
      partSTL: "XY outlines extruded along +Z",
      assemblySTL: "Z-up, base bottom at Z=0",
    },
    disclaimer:
      "샘플 형상입니다. 문화유산의 실측 복원이 아니며 원본·실물 확인 전 제작 승인으로 사용할 수 없습니다. STL 좌표 단위 mm. 절단 도안에 kerf 보정 미적용.",
    ...p,
    sources: p.sources.map(({ url, text, ...s }) => ({
      ...s,
      text: text?.startsWith("data:") ? undefined : text,
    })),
    checks: validateProject(p),
    parts: parts.map((part) => ({
      ...part,
      width: Math.max(...part.outline.map((q) => q[0])),
      height: Math.max(...part.outline.map((q) => q[1])),
    })),
  };
}
export function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function parseDimensions(text: string): Partial<Dimensions> {
  const result: Partial<Dimensions> = {};
  const aliases: Record<string, keyof Dimensions> = {
    width: "width",
    너비: "width",
    가로: "width",
    depth: "depth",
    깊이: "depth",
    세로: "depth",
    wallHeight: "wallHeight",
    벽높이: "wallHeight",
    roofRise: "roofRise",
    지붕높이: "roofRise",
    windowWidth: "windowWidth",
    창문폭: "windowWidth",
    windowHeight: "windowHeight",
    창문높이: "windowHeight",
    doorWidth: "doorWidth",
    문너비: "doorWidth",
    doorHeight: "doorHeight",
    문높이: "doorHeight",
  };
  for (const line of text.split(/[\n\r]/)) {
    const m = line.match(
      /^\s*["']?([\w가-힣]+)(?:_mm)?["']?\s*[:,=]\s*["']?(\d+(?:\.\d+)?)\s*(?:mm)?["']?\s*,?\s*$/,
    );
    if (m) {
      const key = aliases[m[1].replace(/_mm$/, "")];
      if (key && Number(m[2]) > 0) result[key] = Number(m[2]);
    }
  }
  return result;
}
