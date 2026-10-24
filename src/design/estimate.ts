import { Euler, Vector3 } from "three";
import type { BuildingDesign, BuildingElement, Comparison, Evidence, EstimateOptions, PixelImage, Rect, XY } from "./types";
import { area, bounds, cleanRing, inside, openingFits, planeFromPoints, rect, validateDesign } from "./geometry";
import { mergeLockedDesign, protectedIds } from "./editing";

type Component = Rect & { count: number };
function components(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length), result: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 1, minX = width, maxX = 0, minY = height, maxY = 0, count = 0;
    queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen[n] || !mask[n]) continue;
        seen[n] = 1; queue[tail++] = n;
      }
    }
    if (count >= 4) result.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count });
  }
  return result;
}
function clampCrop(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(w - 2, Math.floor(r.x))), y = Math.max(0, Math.min(h - 2, Math.floor(r.y)));
  return { x, y, width: Math.max(2, Math.min(w - x, Math.floor(r.width))), height: Math.max(2, Math.min(h - y, Math.floor(r.height))) };
}
function simplify(points: XY[], tolerance: number): XY[] {
  if (points.length < 3) return points;
  const a = points[0], b = points.at(-1)!;
  let max = 0, at = 0;
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i][0] - dx * points[i][1] + b[0] * a[1] - b[1] * a[0]) / length;
    if (d > max) { max = d; at = i; }
  }
  return max > tolerance ? [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)] : [a, b];
}
function detect(image: PixelImage, options: EstimateOptions, attempt: number) {
  const { width: w, height: h, data } = image;
  if (w < 16 || h < 16 || w * h > 1_600_000 || data.length !== w * h * 4) throw new Error("분석 이미지 크기 또는 픽셀 데이터가 잘못되었습니다.");
  const region = clampCrop(options.crop || { x: 0, y: 0, width: w, height: h }, w, h);
  const cyan = new Uint8Array(w * h), ink = new Uint8Array(w * h), dark = new Uint8Array(w * h);
  let cyanCount = 0, inkCount = 0;
  const cornerIds = [[region.x, region.y], [region.x + region.width - 1, region.y], [region.x, region.y + region.height - 1], [region.x + region.width - 1, region.y + region.height - 1]];
  const bg = [0, 1, 2].map(k => cornerIds.map(([x, y]) => data[(y * w + x) * 4 + k]).sort((a, b) => a - b)[2]);
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
    const p = y * w + x, i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2], light = (r + g + b) / 3;
    if (data[i + 3] < 100) continue;
    if (g > 145 && b > 145 && r < 130 && Math.abs(g - b) < 100) { cyan[p] = 1; cyanCount++; }
    const distance = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    if (distance > 45 && light < 245) { ink[p] = 1; inkCount++; }
    if (light < 115 + attempt * 8) dark[p] = 1;
  }
  if (inkCount < 30) throw new Error("뚜렷한 건물 윤곽을 찾지 못했습니다. 건물 영역을 지정하거나 대비가 있는 자료를 선택해 주세요. 샘플 건물로 대체하지 않았습니다.");
  const cad = cyanCount > 70 && cyanCount > inkCount * 0.035;
  const mask = cad ? cyan : ink;
  const blobs = components(mask, w, h);
  const bodies = blobs.filter(c => c.width >= region.width * 0.14 && c.height >= region.height * 0.12 && c.count / (c.width * c.height) > 0.018);
  bodies.sort((a, b) => b.width * b.height - a.width * a.height);
  const body = bodies[0];
  if (!body) throw new Error("연속된 건물 외곽을 찾지 못했습니다. 건물 외곽이 포함되도록 분석 영역을 지정해 주세요.");
  const crop = clampCrop(body, w, h), bottom = crop.y + crop.height - 1, span = Math.max(1, crop.width - 1);
  const tops: number[] = [];
  for (let x = crop.x; x <= crop.x + span; x++) {
    let found = bottom;
    for (let y = crop.y; y <= bottom; y++) {
      if (mask[y * w + x]) { found = y; break; }
    }
    tops.push(found);
  }
  const smooth = tops.map((_, x) => { const near = tops.slice(Math.max(0, x - 2), Math.min(tops.length, x + 3)).sort((a, b) => a - b); return near[Math.floor(near.length / 2)]; });
  let profile = simplify(smooth.map((y, x) => [x, y - crop.y] as XY), Math.max(1, crop.height * (0.012 + attempt * 0.004)));
  if (profile.length > 28) profile = simplify(profile, crop.height * 0.04);
  if (profile.length > 40) throw new Error("복잡한 외곽을 현재 패널 범위로 안전하게 단순화하지 못했습니다. 분석 영역을 한 입면으로 좁혀 주세요.");
  const low = Math.max(1, ...profile.map(p => p[1])), high = Math.min(...profile.map(p => p[1]));
  const eave = high + (low - high) * 0.65;
  const candidates = components(cad ? cyan : dark, w, h)
    .filter(c => c.x > crop.x + span * 0.012 && c.x + c.width < crop.x + crop.width - span * 0.012 && c.y >= crop.y + eave && c.y < bottom - crop.height * 0.02 && c.width >= Math.max(3, span * 0.018) && c.width < span * 0.32 && c.height >= Math.max(5, crop.height * 0.10) && c.height < crop.height * 0.78 && c.width / c.height > 0.12 && c.width / c.height < 3.8 && c.count / (c.width * c.height) > 0.055)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const merged: Component[] = [];
  for (const c of candidates) {
    const same = merged.find(a => Math.abs(a.x + a.width / 2 - c.x - c.width / 2) < Math.max(a.width, c.width) * 0.36 && c.y <= a.y + a.height + crop.height * 0.045);
    if (same) {
      const right = Math.max(same.x + same.width, c.x + c.width), down = Math.max(same.y + same.height, c.y + c.height);
      same.x = Math.min(same.x, c.x); same.y = Math.min(same.y, c.y); same.width = right - same.x; same.height = down - same.y; same.count += c.count;
    } else merged.push({ ...c });
  }
  const openings = merged.slice(0, 60).map(c => ({ bounds: { x: c.x, y: c.y, width: c.width, height: c.height }, role: (c.y + c.height >= bottom - crop.height * 0.07 ? "door" : "window") as "door" | "window" }));
  return { crop, bottom, span, profile, tops, openings, cad };
}
function evidence(options: EstimateOptions, classification: Evidence["classification"], observation: string, reason: string, region?: Rect): Evidence {
  return { classification, sourceId: options.sourceId, page: options.page, region, coordinateSpace: "image-px", observation, reason, uncertainty: classification === "observed" && options.projection === "orthographic" ? "medium" : "high", alternatives: [], links: [] };
}
function create(image: PixelImage, options: EstimateOptions, attempt: number) {
  const detected = detect(image, options, attempt), { crop, bottom, span } = detected;
  if (!(options.size.targetWidthMm >= 30 && options.size.targetWidthMm <= 2000) || !(options.depthRatio >= 0.08 && options.depthRatio <= 2)) throw new Error("목표 크기 또는 깊이 추정 비율 범위를 확인하세요.");
  const width = options.size.targetWidthMm, scale = width / span, depth = width * options.depthRatio, t = options.fabrication.thicknessMm;
  const prefix = options.sourceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) || "image";
  const profile: XY[] = detected.profile.map(([x, y]) => [x * scale, (bottom - crop.y - y) * scale]);
  const outline = cleanRing([[0, 0], [width, 0], ...profile.slice().reverse()]);
  const elements: BuildingElement[] = [];
  const base = (id: string, name: string, kind: BuildingElement["kind"], poly: XY[], provenance: BuildingElement["provenance"], proof: Evidence): BuildingElement => ({
    id: prefix + "-" + id, name, kind, outline: poly, position: [0, 0, 0], rotation: [0, 0, 0], thickness: t, material: options.fabrication.material, color: kind === "roof" ? "#627263" : "#daccb5", provenance, evidence: [proof], locked: false, userConfirmed: false, measured: false,
  });
  const front = base("front", "관찰 입면 벽", "wall", outline, "observed", evidence(options, "observed", "선택 이미지의 상부 윤곽과 보이는 면", "픽셀 윤곽을 목표 모형 폭에 맞춰 비례 변환했습니다. 실측 크기 확인이 아닙니다.", crop));
  front.position = [-width / 2, 0, depth / 2 - t]; elements.push(front);
  const back = base("back", "보완 후면 벽", "wall", outline, "designed", evidence(options, "designed", "후면 자료 없음", "보이는 입면과 일관된 외곽을 대칭 보완했습니다. 원본 일치 검증 대상이 아닙니다."));
  back.position = [width / 2, 0, -depth / 2 + t]; back.rotation = [0, Math.PI, 0]; elements.push(back);
  const leftHeight = profile[0][1], rightHeight = profile.at(-1)![1];
  const left = base("left", "깊이 추정 좌측 벽", "wall", rect(0, 0, depth - 2 * t, leftHeight), "inferred", evidence(options, "inferred", "측면 깊이는 입면만으로 알 수 없음", "목표 폭의 " + options.depthRatio + "배로 깊이를 가정했습니다."));
  left.position = [-width / 2 + t, 0, -depth / 2 + t]; left.rotation = [0, -Math.PI / 2, 0]; elements.push(left);
  const right = base("right", "깊이 추정 우측 벽", "wall", rect(0, 0, depth - 2 * t, rightHeight), "inferred", evidence(options, "inferred", "측면 깊이 미관찰", "사용자가 조절할 수 있는 깊이 비율로 닫힌 외형을 만들었습니다."));
  right.position = [width / 2 - t, 0, depth / 2 - t]; right.rotation = [0, Math.PI / 2, 0]; elements.push(right);
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i], b = profile[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const roof = base("roof-" + i, "윤곽 지붕 패널 " + (i + 1), "roof", rect(0, 0, len, depth), "inferred", evidence(options, "inferred", "입면 상부 구간 " + (i + 1), "관찰 윤곽을 가정 깊이 방향으로 연결한 평면 패널입니다. 교차 박공지붕의 실제 교차선은 확인하지 못했습니다.", crop));
    const origin: [number, number, number] = [a[0] - width / 2, a[1], depth / 2];
    Object.assign(roof, planeFromPoints(origin, [b[0] - width / 2, b[1], depth / 2], [a[0] - width / 2, a[1], -depth / 2]));
    const normal = new Vector3(0, 0, t).applyEuler(new Euler(...roof.rotation));
    roof.position = roof.position.map((n, k) => n - normal.getComponent(k)) as [number, number, number];
    elements.push(roof);
  }
  for (const [i, detectedOpening] of detected.openings.entries()) {
    const r = detectedOpening.bounds;
    const poly = rect((r.x - crop.x) * scale, Math.max(0, (bottom - r.y - r.height) * scale), Math.max(0.1, (r.width - 1) * scale), Math.max(0.1, (r.height - 1) * scale));
    if (!openingFits(poly, front.outline) || bounds(poly).width <= 2 * (0.8 + options.fabrication.clearanceMm) || bounds(poly).height <= 2 * (0.8 + options.fabrication.clearanceMm)) continue;
    if (elements.some(e => e.kind === "opening" && e.parentId === front.id && e.outline.some(p => inside(p, poly)))) continue;
    const o = base("opening-" + i, (detectedOpening.role === "door" ? "출입구 후보 " : "창문 후보 ") + (i + 1), "opening", poly, "observed", evidence(options, "observed", "경계·대비가 검출된 개구부 후보", "개별 픽셀 위치와 크기를 보존했습니다. 창문/문 분류는 사용자가 확인해야 합니다.", r));
    o.parentId = front.id; o.role = detectedOpening.role; elements.push(o);
    if (options.completion === "complete" && o.role === "window") {
      const rear = structuredClone(o); rear.id += "-back"; rear.name = "미관찰 후면 보완 창문 " + (i + 1); rear.parentId = back.id; rear.provenance = "designed"; rear.outline = poly.map(p => [width - p[0], p[1]] as XY).reverse();
      rear.evidence = [evidence(options, "designed", "후면 창호 자료 없음", "관찰 입면의 반복 형식을 후면에 대칭 적용한 설계 선택입니다. 실제 후면을 판독한 결과가 아닙니다.")]; elements.push(rear);
    }
  }
  const basePlate = base("base", "검토용 베이스", "base", rect(0, 0, width + 12, depth + 12), "designed", evidence(options, "designed", "제작 검토 베이스", "건물 형상과 별도로 양쪽 6 mm 여유를 둔 검토용 바닥판입니다."));
  basePlate.position = [-width / 2 - 6, -2.5, depth / 2 + 6]; basePlate.rotation = [-Math.PI / 2, 0, 0]; basePlate.thickness = 2.5; elements.push(basePlate);
  const warnings = [
    "단일 입면의 윤곽을 깊이 방향으로 연결한 외형 추정입니다. 실제 교차 지붕·숨겨진 입체 형상을 복원한 결과가 아닙니다.",
    "창호 프레임·투명판·표현 색상은 검토용 기본 구성입니다. 실제 창살 패턴이나 자재를 판독한 결과가 아닙니다.",
    "검색 기능은 연결되지 않았으며 외부 자료를 열람했다고 표시하지 않습니다.",
    ...(options.size.mode !== "known-reference" ? ["실제 건물 크기는 확인되지 않았습니다. 목표 모형 mm이며 정밀 1:80 복원을 주장하지 않습니다."] : []),
    ...(options.projection === "perspective" ? ["원근 사진의 비례는 투영의 영향을 받습니다. 현재 결과는 원근 보정 전의 높은 불확실성을 갖습니다."] : []),
    ...(detected.openings.length === 0 ? ["개구부 후보를 찾지 못했습니다. 보이는 면에 고정 창문을 자동 추가하지 않았습니다."] : []),
  ];
  const scene: BuildingDesign = {
    schema: "tradiative.building.v2", revision: 1, createdAt: new Date().toISOString(), size: structuredClone(options.size), fabrication: structuredClone(options.fabrication),
    elements, observations: [{ sourceId: options.sourceId, page: options.page, pixelWidth: image.width, pixelHeight: image.height, crop, projection: options.projection, view: "front", rectified: false,
      silhouette: [[crop.x, bottom], [crop.x + span, bottom], ...detected.profile.slice().reverse().map(([x, y]) => [crop.x + x, crop.y + y] as XY)],
      openings: detected.openings, warnings }],
    assumptions: [evidence(options, "inferred", "깊이와 보이지 않는 면", "깊이 비율 " + options.depthRatio + "와 보완 성향 " + options.completion + "을 적용했습니다.")],
    limitations: warnings,
  };
  return scene;
}
export function compareFront(scene: BuildingDesign): Comparison {
  const observation = scene.observations.find(o => o.view === "front"), front = scene.elements.find(e => e.kind === "wall" && e.provenance === "observed");
  let intersection = 0, union = 0;
  const errors: number[] = [];
  if (observation && front) {
    const crop = observation.crop, pixelToMm = scene.size.targetWidthMm / (crop.width - 1);
    for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
      const observed = inside([crop.x + (x + 0.5) / 128 * (crop.width - 1), crop.y + (y + 0.5) / 96 * (crop.height - 1)], observation.silhouette);
      const projected = inside([(x + 0.5) / 128 * scene.size.targetWidthMm, (1 - (y + 0.5) / 96) * (crop.height - 1) * pixelToMm], front.outline);
      if (observed && projected) intersection++;
      if (observed || projected) union++;
    }
    for (const opening of scene.elements.filter(e => e.kind === "opening" && e.parentId === front.id)) {
      const source = opening.evidence.find(e => e.classification === "observed" && e.sourceId === observation.sourceId && e.region)?.region;
      if (!source) continue;
      const actual = bounds(opening.outline);
      const expectedX = (source.x - crop.x + (source.width - 1) / 2) * pixelToMm;
      const expectedY = (crop.y + crop.height - 1 - source.y - source.height + (source.height - 1) / 2) * pixelToMm;
      errors.push(Math.hypot(actual.x + actual.width / 2 - expectedX, actual.y + actual.height / 2 - expectedY));
    }
  }
  return { method: "front-silhouette-projection", silhouetteIoU: union ? intersection / union : 0, openingCount: errors.length, openingMeanErrorMm: errors.length ? errors.reduce((s, n) => s + n, 0) / errors.length : undefined,
    evaluatedView: "front", independentVerification: false, unverifiedViews: ["back", "left", "right", "roof-intersections"], note: "추출 윤곽과 전면 투영의 내부 일관성 지표입니다. 독립적인 원본 정확도·고증·제작 승인 점수가 아닙니다." };
}
export function repairDesign(scene: BuildingDesign) {
  const next = structuredClone(scene), locked = protectedIds(scene), changedIds: string[] = [];
  for (const issue of validateDesign(scene)) {
    if (issue.code !== "outside-opening") continue;
    const opening = next.elements.find(e => e.id === issue.elementIds[0]), wall = next.elements.find(e => e.id === issue.elementIds[1]);
    if (!opening || !wall || locked.has(opening.id)) continue;
    const ob = bounds(opening.outline), wb = bounds(wall.outline), margin = 0.05;
    const dx = Math.max(wb.x + margin, Math.min(ob.x, wb.x + wb.width - ob.width - margin)) - ob.x;
    const dy = Math.max(wb.y + margin, Math.min(ob.y, wb.y + wb.height - ob.height - margin)) - ob.y;
    const shifted = opening.outline.map(p => [p[0] + dx, p[1] + dy] as XY);
    if (openingFits(shifted, wall.outline) && (dx || dy)) {
      opening.outline = shifted; opening.provenance = "inferred"; opening.userConfirmed = false;
      opening.evidence.push({ classification: "inferred", observation: "벽 밖 개구부 수치 검사", reason: "벽 안으로 최소 평행 이동했습니다. 원본 위치와 다시 대조해야 합니다.", uncertainty: "high", alternatives: [], links: [] });
      changedIds.push(opening.id);
    }
  }
  if (changedIds.length) next.revision++;
  return { scene: next, changedIds };
}
export function estimateDesign(image: PixelImage, options: EstimateOptions, previous?: BuildingDesign, progress?: (scene: BuildingDesign) => void): BuildingDesign {
  if (previous?.elements.some(e => e.locked) && (JSON.stringify(previous.size) !== JSON.stringify(options.size) || JSON.stringify(previous.fabrication) !== JSON.stringify(options.fabrication))) throw new Error("잠긴 요소를 보존하기 위해 전체 크기·제작 조건 변경은 적용하지 않았습니다. 같은 기준으로 재생성하거나 잠금을 먼저 확인해 주세요.");
  const start = Date.now(), max = Math.max(1, Math.min(5, Math.floor(options.maxIterations))), duration = Math.max(1000, Math.min(60000, options.maxDurationMs));
  let best: BuildingDesign | undefined, bestScore = -Infinity;
  const attempts: NonNullable<BuildingDesign["run"]>["attempts"] = [];
  for (let iteration = 0; iteration < max; iteration++) {
    if (Date.now() - start > duration) break;
    let scene = create(image, options, iteration);
    if (previous) scene = mergeLockedDesign(previous, scene);
    const repaired = repairDesign(scene); scene = repaired.scene;
    const issueCount = validateDesign(scene).filter(i => i.severity === "error").length, comparison = compareFront(scene);
    const score = comparison.silhouetteIoU - issueCount * 2 - (comparison.openingMeanErrorMm || 0) / scene.size.targetWidthMm - scene.elements.length * 0.00001;
    attempts.push({ iteration: iteration + 1, issueCount, comparison, changedIds: repaired.changedIds });
    if (score > bestScore) { best = scene; bestScore = score; }
    best!.run = { id: "local-" + start, engine: "local-image-estimator", state: "running", startedAt: new Date(start).toISOString(), attempts: structuredClone(attempts), requestCount: 0, maxRequests: 0, maxIterations: max, elapsedMs: Date.now() - start, actualAiCompleted: false, search: "not-connected", warnings: scene.limitations };
    progress?.(structuredClone(best!));
    if (!issueCount && comparison.silhouetteIoU > 0.97) break;
  }
  if (!best) throw new Error("설정한 시간 안에 결과를 만들지 못했습니다.");
  const errors = validateDesign(best).filter(i => i.severity === "error");
  best.run!.state = errors.length || Date.now() - start > duration ? "limited" : "completed-with-review";
  best.run!.finishedAt = new Date().toISOString(); best.run!.elapsedMs = Date.now() - start; best.run!.attempts = attempts;
  if (errors.length) best.run!.warnings.push("해결하지 못한 형상 오류가 있습니다. 내보내기는 차단됩니다.");
  if (area(best.elements.find(e => e.kind === "wall")!.outline) < 1) throw new Error("유효한 건물 윤곽을 만들지 못했습니다.");
  return best;
}
