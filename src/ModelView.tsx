import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Expand,
  Layers3,
  RotateCcw,
  MousePointer2,
  Box,
  MoveUpRight,
} from "lucide-react";
import { buildParts, geometryFor, svgDrawing, type Dimensions, type Part } from "./engine";
import type { BuildingDesign } from "./design/types";
import { modelBounds } from "./design/geometry";

export default function ModelView({
  dimensions: d,
  projectName,
  selected,
  onSelect,
  design,
  providedParts,
  pendingImage,
}: {
  dimensions: Dimensions;
  projectName: string;
  selected: string;
  onSelect: (id: string) => void;
  design?: BuildingDesign;
  providedParts?: Part[];
  pendingImage?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"3d" | "front" | "plan">("3d");
  const [exploded, setExploded] = useState(false);
  const [reset, setReset] = useState(0);
  const [error, setError] = useState(false);
  const [proofColors, setProofColors] = useState(false);
  const [ruler, setRuler] = useState({ width: 50, length: 50 });
  useEffect(() => {
    const el = mount.current;
    if (!el || view === "plan") return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError(true);
      return;
    }
    setError(false);
    const width = el.clientWidth,
      height = el.clientHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor("#f0f0e9", 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const dimensions = design ? modelBounds(design) : undefined;
    const parts = providedParts || buildParts(d),
      w = dimensions?.width || d.width / d.scale,
      depth = dimensions?.depth || d.depth / d.scale,
      h = dimensions ? dimensions.height * 0.7 : d.wallHeight / d.scale,
      rise = dimensions ? dimensions.height * 0.3 : d.roofRise / d.scale;
    const baseSpan =
      Math.max(w, depth, (h + rise) * 1.8, 100) * (exploded ? 1.45 : 1.15);
    const fittedSpan = (aspect: number) =>
      Math.max(
        baseSpan,
        ((w + depth + 28) * 0.95 * (exploded ? 1.3 : 1)) / aspect,
      );
    const aspect = width / height;
    const span = fittedSpan(aspect);
    const camera = new THREE.OrthographicCamera(
      (-span * aspect) / 2,
      (span * aspect) / 2,
      span / 2,
      -span / 2,
      0.1,
      4000,
    );
    const target = new THREE.Vector3(0, (h + rise) * 0.34, 0);
    if (view === "front") camera.position.set(0, target.y, 600);
    else camera.position.set(240, 175, 275);
    camera.lookAt(target);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.minZoom = 0.5;
    controls.maxZoom = 3;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.enableRotate = view === "3d";
    scene.add(new THREE.AmbientLight("#ffffff", 2.1));
    const sun = new THREE.DirectionalLight("#fff9e9", 3.2);
    sun.position.set(-130, 240, 120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -280;
    sun.shadow.camera.right = 280;
    sun.shadow.camera.top = 240;
    sun.shadow.camera.bottom = -240;
    sun.shadow.normalBias = 0.3;
    scene.add(sun);
    const fill = new THREE.DirectionalLight("#dbe8e5", 1.2);
    fill.position.set(140, 70, -150);
    scene.add(fill);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({ color: "#f0f0e9", roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.61;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(1000, 100, "#d6dad0", "#e1e3da");
    grid.position.y = -2.59;
    scene.add(grid);
    const building = new THREE.Group();
    scene.add(building);
    const interactables: THREE.Mesh[] = [];
    const lineMaterial = new THREE.LineBasicMaterial({
      color: "#7b7563",
      transparent: true,
      opacity: 0.23,
    });
    parts.forEach((p) => {
      const geometry = geometryFor(p);
      const material = new THREE.MeshStandardMaterial({
        color: p.id === selected ? "#cc865a" : proofColors && p.provenance ? ({ observed: "#6b9f92", inferred: "#c5a468", designed: "#ab85a1" })[p.provenance] : p.color,
        roughness: p.group === "glass" ? 0.2 : 0.88,
        metalness: p.group === "roof" ? 0.15 : 0,
        transparent: p.group === "glass",
        opacity: p.group === "glass" ? 0.54 : 1,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...p.position);
      mesh.rotation.set(...p.rotation);
      mesh.userData.partId = p.id;
      if (exploded) {
        if (p.group === "roof") mesh.position.y += 38;
        else if (p.group === "window" || p.group === "glass") {
          const out = new THREE.Vector3(0, 0, 15).applyEuler(mesh.rotation);
          mesh.position.add(out);
        } else if (p.id === "W-01") mesh.position.z += 15;
        else if (p.id === "W-02") mesh.position.z -= 15;
        else if (p.id === "W-03") mesh.position.x -= 15;
        else if (p.id === "W-04") mesh.position.x += 15;
      }
      mesh.castShadow = p.group !== "glass";
      mesh.receiveShadow = true;
      building.add(mesh);
      interactables.push(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({
          color: p.group === "roof" ? "#344c3f" : "#8a806a",
          transparent: true,
          opacity: 0.35,
        }),
      );
      mesh.add(edges);
      if (p.group === "roof" && !design) {
        const rw = Math.max(...p.outline.map((q) => q[0])),
          rh = Math.max(...p.outline.map((q) => q[1]));
        const points = [];
        for (let x = 6; x < rw; x += 6)
          points.push(
            new THREE.Vector3(x, 0, -0.045),
            new THREE.Vector3(x, rh, -0.045),
          );
        mesh.add(
          new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({
              color: "#b1b9a2",
              transparent: true,
              opacity: 0.28,
            }),
          ),
        );
      }
      if (p.group === "wall" && !design) {
        const points: THREE.Vector3[] = [];
        const pw = Math.max(...p.outline.map((q) => q[0]));
        for (let y = 3; y < h; y += 3) {
          const cuts = p.holes
            .filter((hole) => y > hole[0][1] && y < hole[2][1])
            .map((hole) => [hole[0][0], hole[1][0]]);
          if (p.id === "W-01" && y < d.doorHeight / d.scale)
            cuts.push([
              (pw - d.doorWidth / d.scale) / 2,
              (pw + d.doorWidth / d.scale) / 2,
            ]);
          cuts.sort((a, b) => a[0] - b[0]);
          let from = 0;
          for (const [a, b] of cuts) {
            points.push(
              new THREE.Vector3(from, y, p.thickness + 0.025),
              new THREE.Vector3(a, y, p.thickness + 0.025),
            );
            from = b;
          }
          points.push(
            new THREE.Vector3(from, y, p.thickness + 0.025),
            new THREE.Vector3(pw, y, p.thickness + 0.025),
          );
        }
        mesh.add(
          new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(points),
            lineMaterial,
          ),
        );
      }
    });
    // A non-fabrication label, like the annotations on a physical study model.
    if (parts.length && !exploded && !design) {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#e9e4d1";
      ctx.fillRect(0, 0, 512, 180);
      ctx.strokeStyle = "#605e4a";
      ctx.lineWidth = 9;
      ctx.strokeRect(6, 6, 500, 168);
      ctx.fillStyle = "#3f5143";
      ctx.font = "bold 62px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(projectName.replace(/\s*본관$/, "").slice(0, 8), 256, 87);
      ctx.font = "23px sans-serif";
      ctx.fillText("T R A D I A T I V E", 256, 140);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(15, 5.3),
        new THREE.MeshBasicMaterial({ map: texture }),
      );
      sign.position.set(0, h - 5, depth / 2 + 0.12);
      building.add(sign);
    }
    let frame = 0;
    let alive = true;
    const animate = () => {
      if (!alive) return;
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const updateRuler = () => {
      const pixelsPerMm =
        (el.clientWidth * camera.zoom) / (camera.right - camera.left);
      const length =
        50 * pixelsPerMm > 110 ? 20 : 50 * pixelsPerMm < 45 ? 100 : 50;
      const width = Math.round(length * pixelsPerMm);
      setRuler((prev) =>
        prev.width === width && prev.length === length
          ? prev
          : { width, length },
      );
    };
    controls.addEventListener("change", updateRuler);
    updateRuler();
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      const a = w / h,
        s = fittedSpan(a);
      camera.left = (-s * a) / 2;
      camera.right = (s * a) / 2;
      camera.top = s / 2;
      camera.bottom = -s / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      updateRuler();
    });
    observer.observe(el);
    let startX = 0,
      startY = 0;
    const down = (e: PointerEvent) => {
      startX = e.clientX;
      startY = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 5) return;
      const r = el.getBoundingClientRect();
      const point = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(point, camera);
      const hit = ray
        .intersectObjects(interactables, false)
        .find((x) => x.object.userData.partId);
      if (hit) onSelect(hit.object.userData.partId);
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", up);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if ("map" in m && m.map instanceof THREE.Texture) m.map.dispose();
            m.dispose();
          });
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [d, projectName, view, exploded, reset, selected, onSelect, design, providedParts, proofColors]);
  const parts = providedParts || buildParts(d);
  const dimensions = design ? modelBounds(design) : undefined;
  return (
    <section className="model-card">
      <div className="model-toolbar">
        <div>
          <span className="eyebrow">DIGITAL WORKBENCH</span>
          <h2>
            디지털 작업대 <span className="live-dot" />
          </h2>
        </div>
        <div className="segmented" aria-label="모델 보기">
          {[
            ["3d", "3D 모델"],
            ["front", "정면도"],
            ["plan", "부품 도안"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id as typeof view)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {design && <label className="model-proof-control"><input type="checkbox" checked={proofColors} onChange={e => setProofColors(e.target.checked)}/>근거 색상: 관찰 · 추정 · 설계 보완</label>}
      <div
        className="model-canvas"
        ref={mount}
        aria-label="회전 가능한 건축 모형 3D 미리보기"
      >
        {view === "plan" && (
          <div
            className="svg-preview"
            dangerouslySetInnerHTML={{
              __html: svgDrawing(parts, d, design?.size, design?.fabrication).replace(/<\?xml.*?\?>/, ""),
            }}
          />
        )}
        {error && view !== "plan" && (
          <div className="canvas-fallback">
            <Box size={42} />
            <p>3D 그래픽을 사용할 수 없습니다.</p>
            <button onClick={() => setView("plan")}>부품 도안 보기</button>
          </div>
        )}
        {pendingImage && <div className="canvas-fallback"><Box size={35}/><p>이미지 모델을 아직 만들지 않았습니다.</p><p>위의 ‘이미지에서 외형 추정’을 실행해 주세요.</p></div>}
        <div className="canvas-label">
          <span className="tiny-dot" />{" "}
          {view === "plan"
            ? "제작 전 검토용 · kerf 보정 전"
            : design ? "이미지 윤곽 추정 · 깊이 보완 · 검토용" : "기존 예시 형상 · 이미지 분석 결과 아님"}
        </div>
        <div className="compass">
          <span>N</span>
          <MoveUpRight size={24} />
        </div>
        <div className="canvas-tools">
          <button
            title="시점 초기화"
            aria-label="시점 초기화"
            onClick={() => setReset((v) => v + 1)}
          >
            <RotateCcw size={17} />
          </button>
          <button
            title="분해도"
            aria-label="분해도"
            className={exploded ? "selected" : ""}
            onClick={() => {
              setView("3d");
              setExploded((v) => !v);
            }}
          >
            <Layers3 size={18} />
          </button>
          <button
            title="작업대 확대"
            aria-label="작업대 확대"
            onClick={() => {
              if (!document.fullscreenElement)
                void mount.current?.parentElement?.requestFullscreen?.();
              else void document.exitFullscreen();
            }}
          >
            <Expand size={17} />
          </button>
        </div>
        <div className="canvas-hint">
          <MousePointer2 size={12} />
          <span>드래그하여 회전 · 스크롤하여 확대</span>
        </div>
        {view !== "plan" && (
          <div className="scale-ruler">
            <span>0</span>
            <i style={{ width: ruler.width }} />
            <span>{ruler.length} mm</span>
          </div>
        )}
      </div>
      <div className="model-footer">
        <span className="scale-tag">{design ? design.size.mode === "known-reference" ? "입력 기준 1:" + design.size.scaleDenominator : "목표 모형 mm" : "1 : " + d.scale}</span>
        <span>
          모형 크기{" "}
          <b>
            {(dimensions?.width ?? d.width / d.scale).toFixed(1)} × {(dimensions?.depth ?? d.depth / d.scale).toFixed(1)}{" "}
            × {(dimensions?.height ?? (d.wallHeight + d.roofRise) / d.scale).toFixed(1)}
          </b>{" "}
          <small>mm</small>
        </span>
        <span className="model-count">
          <Box size={14} /> {parts.length}개 파츠
        </span>
      </div>
    </section>
  );
}
