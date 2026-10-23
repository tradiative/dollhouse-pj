import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  FileCheck2,
  FileImage,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  Grid2X2,
  Layers3,
  LoaderCircle,
  Menu,
  Plus,
  Ruler,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import ModelView from "./ModelView";
import DesignStudio from "./DesignStudio";
import type { BuildingDesign } from "./design/types";
import { modelBounds, validateDesign } from "./design/geometry";
import { snapshot } from "./design/editing";
import { parseProjectMetadata } from "./design/archive";
import { imageData, readSourceFile, saveSourceFile } from "./sourceStore";
import {
  projectParts,
  projectSignature,
  awaitingImageModel,
  DEFAULT_DIMENSIONS,
  download,
  dxfDrawing,
  geometryIssues,
  manifest,
  parseDimensions,
  sampleProject,
  stlAssembly,
  stlPart,
  svgDrawing,
  validDimensions,
  validateProject,
  type Dimensions,
  type Project,
  type Source,
} from "./engine";

const STORAGE = "tradiative.studio.project.v1";
const stages = [
  { name: "자료 수집", en: "REFERENCES", icon: FolderOpen },
  { name: "설계 기준", en: "DESIGN RULES", icon: Ruler },
  { name: "부품 모델링", en: "PART MODELING", icon: Box },
  { name: "검수", en: "REVIEW", icon: ShieldCheck },
  { name: "파일 내보내기", en: "DELIVERABLES", icon: ArrowDownToLine },
];
const dimensionLabels: Record<keyof Dimensions, string> = {
  width: "건물 너비",
  depth: "건물 깊이",
  wallHeight: "벽체 높이",
  roofRise: "지붕 높이",
  windowWidth: "창문 너비",
  windowHeight: "창문 높이",
  doorWidth: "출입문 너비",
  doorHeight: "출입문 높이",
  scale: "축척",
  thickness: "벽체 재료 두께",
  kerf: "절단 폭 (kerf)",
  clearance: "편측 조립 여유",
};
type Candidate = {
  field: keyof Dimensions;
  value: number;
  evidence: string;
  sourceId?: string;
  confidence?: string;
};
function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const p = JSON.parse(raw);
      if (
        typeof p.name === "string" &&
        validDimensions(p.dimensions) &&
        Array.isArray(p.sources)
      )
        return {
          ...sampleProject(),
          ...p,
          design: p.design ? parseProjectMetadata({ ...p, schema: "tradiative.project.v2" }).design : undefined,
          designHistory: p.designHistory || [],
          name: p.name.slice(0, 100),
          confirmed: p.confirmed === true,
          physicalConfirmed: p.physicalConfirmed === true,
          physicalNote:
            typeof p.physicalNote === "string" ? p.physicalNote : "",
          generatedSignature:
            typeof p.generatedSignature === "string"
              ? p.generatedSignature
              : "",
          sources: p.sources.map((s: Source) => ({ ...s, url: undefined })),
        };
    }
  } catch {
    /* Keep a corrupt local file from preventing startup. */
  }
  return sampleProject();
}
const bytes = (n: number) =>
  n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function App() {
  const [project, setProject] = useState<Project>(loadProject);
  const [stage, setStage] = useState(1);
  const [nav, setNav] = useState("workspace");
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<
    "export" | "guide" | "new" | "settings" | "source" | null
  >(null);
  const [previewSource, setPreviewSource] = useState<Source | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [newName, setNewName] = useState("");
  const [storageError, setStorageError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  const onSelect = useCallback((id: string) => {
    setSelected(id);
    setStage(2);
  }, []);
  const notify = useCallback((text: string) => setToast(text), []);
  const d = project.dimensions;
  const pendingImage = awaitingImageModel(project);
  const parts = useMemo(() => projectParts(project), [d, project.design, pendingImage]);
  const sceneBounds = project.design ? modelBounds(project.design) : undefined;
  const selectedElementId = parts.find(p => p.id === selected)?.sourceElementId || selected;
  const checks = useMemo(() => validateProject(project), [project]);
  const passed = checks.filter((c) => c.status === "pass").length;
  const progress = Math.round((passed / checks.length) * 100);
  const generated = project.generatedSignature === projectSignature(project);
  const issues = project.design ? validateDesign(project.design).filter(i => i.severity === "error").map(i => i.message) : pendingImage ? ["이미지 모델 생성 전입니다. 위의 이미지 외형 추정을 실행하거나 직접 입력한 치수를 원본과 대조해 주세요."] : geometryIssues(d);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((r) => r.json())
      .then((r) => setAiConfigured(r.aiConfigured === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => () => urlsRef.current.forEach(URL.revokeObjectURL), []);
  const sourceIds = project.sources.map((s) => s.id).join("|");
  const missingSourceIds = project.sources
    .filter((s) => !s.sample && !s.url)
    .map((s) => s.id)
    .join("|");
  useEffect(() => {
    let cancelled = false;
    const missing = project.sources.filter((s) => !s.sample && !s.url);
    void Promise.all(
      missing.map(async (s) => {
        try {
          const file = await readSourceFile(s.id);
          if (!file || cancelled) return undefined;
          const text = /^image\/(png|jpeg|webp)$/.test(s.type)
            ? await imageData(file)
            : s.text;
          return { id: s.id, file, text };
        } catch {
          return undefined;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const restored = results
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => {
          const url = URL.createObjectURL(s.file);
          urlsRef.current.push(url);
          return { ...s, url };
        });
      if (restored.length)
        setProject((p) => ({
          ...p,
          sources: p.sources.map((s) => {
            const file = restored.find((r) => r.id === s.id);
            return file ? { ...s, url: file.url, text: file.text } : s;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [sourceIds, missingSourceIds]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(null);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null,
      oldOverflow = document.body.style.overflow;
    const container = document.querySelector<HTMLElement>(".modal");
    document.body.style.overflow = "hidden";
    container
      ?.querySelector<HTMLElement>(modal === "new" ? "input" : "button")
      ?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !container) return;
      const els = [
        ...container.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input,textarea,select,a[href]",
        ),
      ];
      const first = els[0],
        last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal]);
  const update = (patch: Partial<Project>) =>
    setProject((p) => ({
      ...p,
      ...patch,
      updatedAt: new Date().toISOString(),
    }));
  const updateDimension = (key: keyof Dimensions, value: number) => {
    setProject((p) => ({
      ...p,
      dimensions: { ...p.dimensions, [key]: value },
      confirmed: false,
      physicalConfirmed: false,
      updatedAt: new Date().toISOString(),
    }));
  };
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const accepted: Source[] = [];
    let skipped = 0;
    let unsaved = 0;
    for (const f of Array.from(files)) {
      if (
        f.size > 10 * 1024 * 1024 ||
        !/\.(png|jpg|jpeg|webp|pdf|svg|dxf|csv|txt)$/i.test(f.name)
      ) {
        skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      const source: Source = {
        id,
        name: f.name,
        type: f.type || "application/octet-stream",
        size: f.size,
      };
      try {
        await saveSourceFile(id, f);
      } catch {
        unsaved++;
      }
      source.url = URL.createObjectURL(f);
      urlsRef.current.push(source.url);
      if (/\.(csv|txt|dxf)$/i.test(f.name)) {
        source.text = await f.text();
        if (source.text.length > 150000)
          source.text = source.text.slice(0, 150000);
      }
      if (/^image\/(png|jpeg|webp)$/.test(f.type)) {
        // Keep image data out of localStorage; original files live in IndexedDB.
        source.text = await imageData(f);
      }
      accepted.push(source);
    }
    setProject((p) => ({
      ...p,
      sources: [...p.sources, ...accepted],
      confirmed: false,
      generatedSignature: "",
      physicalConfirmed: false,
      updatedAt: new Date().toISOString(),
    }));
    notify(
      `${accepted.length}개 자료를 추가했습니다.${skipped ? " 지원하지 않는 형식 또는 10 MB 초과 파일은 제외했습니다." : ""}${unsaved ? ` ${unsaved}개 원본은 브라우저 보관에 실패했습니다. 탭을 닫기 전에 원본을 별도로 보관해 주세요.` : ""}`,
    );
    if (inputRef.current) inputRef.current.value = "";
  }
  async function analyze() {
    setAnalyzing(true);
    setCandidates([]);
    try {
      const local: Candidate[] = project.sources
        .filter((s) => s.text && !s.text.startsWith("data:"))
        .flatMap((s) =>
          Object.entries(parseDimensions(s.text!)).map(([field, value]) => ({
            field: field as keyof Dimensions,
            value: value!,
            evidence: `${s.name}의 치수 항목`,
            sourceId: s.id,
            confidence: "원문 값",
          })),
        );
      const actual = project.sources.filter((s) => !s.sample && s.text);
      if (aiConfigured && actual.length) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sources: actual.map(({ id, name, text, type }) => ({
              id,
              name,
              text,
              type,
            })),
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "AI 분석 요청에 실패했습니다.");
        const remote: Candidate[] = result.candidates.filter(
          (c: Candidate) =>
            c.field in DEFAULT_DIMENSIONS &&
            c.value > 0 &&
            Number.isFinite(c.value),
        );
        setCandidates([
          ...local.filter((a) => !remote.some((b) => a.field === b.field)),
          ...remote,
        ]);
        notify(
          remote.length || local.length
            ? "분석 결과를 원본과 대조한 뒤 설계에 반영해 주세요."
            : "명시된 치수 표기를 찾지 못했습니다. 기준 치수를 직접 입력해 주세요.",
        );
      } else if (local.length) {
        setCandidates(local);
        notify(
          "텍스트에 명시된 치수를 읽었습니다. 사진 AI 분석은 별도 연결이 필요합니다.",
        );
      } else {
        notify(
          aiConfigured
            ? "분석 가능한 이미지나 치수 텍스트를 다시 첨부해 주세요."
            : "치수 텍스트를 찾지 못했습니다. 이미지 형상은 위의 ‘이미지에서 외형 추정’을 사용하세요.",
        );
      }
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "자료 분석 중 오류가 발생했습니다.",
      );
    } finally {
      setAnalyzing(false);
    }
  }
  function generate() {
    if (issues.length) {
      notify(issues[0]);
      return;
    }
    update({ generatedSignature: projectSignature(project) });
    notify(`${parts.length}개 파츠를 현재 설계 기준으로 생성했습니다.`);
  }
  function exportFile(format: "svg" | "dxf" | "stl" | "json") {
    if (format !== "json" && issues.length) {
      notify("설계 기준의 치수 오류를 먼저 해결해 주세요.");
      return;
    }
    if (format !== "json" && !generated) {
      notify("현재 설계 기준으로 부품을 먼저 생성해 주세요.");
      setModal(null);
      setStage(2);
      return;
    }
    const safeName = project.name.replace(/[\\/:*?"<>|]/g, "_");
    const sizeLabel = project.design ? (project.design.size.mode === "known-reference" ? "1-" + project.design.size.scaleDenominator : "목표폭-" + project.design.size.targetWidthMm + "mm") : "1-" + d.scale;
    const prefix = safeName + "_" + sizeLabel + "_검토용";
    if (format === "svg")
      download(svgDrawing(parts, d, project.design?.size, project.design?.fabrication), `${prefix}.svg`, "image/svg+xml");
    if (format === "dxf")
      download(dxfDrawing(parts), `${prefix}.dxf`, "application/dxf");
    if (format === "stl")
      download(stlAssembly(parts), `${prefix}.stl`, "model/stl");
    if (format === "json")
      download(
        JSON.stringify(manifest(project), null, 2),
        `${prefix}.json`,
        "application/json",
      );
    notify(
      `${format.toUpperCase()} 파일을 내보냈습니다. 제작 전 검수 상태를 확인해 주세요.`,
    );
  }
  async function importProject(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024)
        throw new Error("프로젝트 JSON은 2 MB 이하만 가져올 수 있습니다.");
      const restored = parseProjectMetadata(JSON.parse(await file.text()));
      setProject(restored);
      setCandidates([]);
      setSelected("");
      setStage(1);
      setNav("workspace");
      notify("프로젝트를 가져왔습니다. 치수와 자료를 다시 확인해 주세요.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "프로젝트를 가져올 수 없습니다.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }
  function createProject() {
    if (!newName.trim()) return;
    download(
      JSON.stringify(manifest(project), null, 2),
      `${project.name}_백업.json`,
      "application/json",
    );
    setProject({ ...sampleProject(), name: newName.trim(), sources: [] });
    setCandidates([]);
    setSelected("");
    setStage(0);
    setModal(null);
    setNav("workspace");
    notify(
      "새 프로젝트를 열었습니다. 이전 프로젝트는 백업 파일로 내려받았습니다.",
    );
  }
  const applyDesign = (design: BuildingDesign, label: string) => {
    setProject(p => ({ ...p, design, designHistory: [...(p.designHistory || []), ...(p.design ? [snapshot(p.design, label)] : [])].slice(-10), confirmed: false, physicalConfirmed: false, generatedSignature: "", updatedAt: new Date().toISOString() }));
  };
  const undoDesign = () => {
    setProject(p => {
      const history = p.designHistory || [], previous = history.at(-1);
      return previous ? { ...p, design: structuredClone(previous.design), designHistory: history.slice(0, -1), generatedSignature: "", confirmed: false, physicalConfirmed: false, updatedAt: new Date().toISOString() } : p;
    });
  };
  const go = (i: number) => {
    setStage(i);
    setNav("workspace");
    setMobileNav(false);
  };
  const visibleParts = parts.filter(
    (p) =>
      (filter === "all" || p.group === filter) &&
      `${p.id} ${p.name}`.toLowerCase().includes(query.toLowerCase()),
  );
  const persistableProject = {
    ...project,
    sources: project.sources.map((s) => ({
      ...s,
      text: s.text?.startsWith("data:") ? undefined : s.text,
    })),
  };
  // Keep original file bytes in IndexedDB, outside metadata and portable JSON.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          ...persistableProject,
          sources: persistableProject.sources.map(({ url, ...s }) => s),
        }),
      );
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [project]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go(1);
          }}
          aria-label="트레디에이티브 작업실 홈"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            TRADIATIVE<small>HERITAGE, REIMAGINED.</small>
          </span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-avatar">T</span>
          <div>
            <b>트레디에이티브 작업실</b>
            <small>건축 모형 제작 워크스페이스</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-heading">WORKSPACE</span>
        <nav aria-label="주 메뉴">
          <button
            className={nav === "workspace" ? "active" : ""}
            onClick={() => {
              setNav("workspace");
              setMobileNav(false);
            }}
          >
            <Grid2X2 size={18} />
            프로젝트 작업실
            <span className="nav-dot" />
          </button>
          <button
            className={nav === "library" ? "active" : ""}
            onClick={() => {
              setNav("library");
              setStage(0);
              setMobileNav(false);
            }}
          >
            <FolderClosed size={18} />
            자료 라이브러리
            <span className="nav-count">{project.sources.length}</span>
          </button>
          <button
            className={nav === "review" ? "active" : ""}
            onClick={() => {
              setNav("review");
              setStage(3);
              setMobileNav(false);
            }}
          >
            <ClipboardCheck size={18} />
            검수 기록<span className="nav-count">{passed}</span>
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-heading projects-heading">
          MY PROJECTS
          <button aria-label="새 프로젝트" onClick={() => setModal("new")}>
            <Plus size={15} />
          </button>
        </div>
        <button className="project-link" onClick={() => go(1)}>
          <span className="project-square" />
          {project.name}
          <span className="project-link-dot" />
        </button>
        <button className="new-project" onClick={() => setModal("new")}>
          <Plus size={15} />새 프로젝트 만들기
        </button>
        <div className="sidebar-bottom">
          <div className="studio-note">
            <span>
              FROM ARCHIVE
              <br />
              TO ARCHITECTURE.
            </span>
            <div className="line-building">
              <i />
              <i />
              <i />
              <i />
            </div>
            <p>
              기억할 가치가 있는 건축,
              <br />
              당신의 손으로 다시 만듭니다.
            </p>
          </div>
          <button className="help-link" onClick={() => setModal("guide")}>
            <CircleHelp size={17} />
            작업 가이드
            <ArrowUpRight size={14} />
          </button>
          <div className="user">
            <span>T</span>
            <div>
              <b>트레디에이티브</b>
              <small>로컬 작업실</small>
            </div>
            <button
              title="작업실 설정"
              aria-label="작업실 설정"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          aria-label="메뉴 닫기"
          className="nav-backdrop"
          onClick={() => setMobileNav(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu"
              aria-label="메뉴 열기"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>워크스페이스</span>
            <ChevronRight size={13} />
            <span>프로젝트</span>
            <ChevronRight size={13} />
            <b>{project.name}</b>
          </div>
          <div className="topbar-right">
            <span className={`save-status ${storageError ? "error" : ""}`}>
              <span />
              {storageError ? "저장 공간 부족" : "브라우저에 저장됨"}
            </span>
            <i />
            <button
              aria-label="가이드 열기"
              title="작업 가이드"
              onClick={() => setModal("guide")}
            >
              <BookOpen size={18} />
            </button>
            <span className="profile-avatar">T</span>
          </div>
        </header>
        <main>
          <div className="project-heading">
            <div>
              <div className="project-eyebrow">
                <span>ARCHITECTURAL MODEL</span>
                <i />
                PROJECT 001{" "}
                <span className="sample-badge">
                  {project.sources.some((s) => s.sample)
                    ? "샘플 프로젝트"
                    : "로컬 프로젝트"}
                </span>
              </div>
              <div className="title-line">
                <h1>{project.name}</h1>
                <span className="status-badge">
                  <span />
                  {passed === checks.length
                    ? "검수 기록 완료"
                    : generated
                      ? "부품 생성됨"
                      : "설계 검토 중"}
                </span>
              </div>
              <p>건축의 기억을 담고, 만드는 과정을 정교하게.</p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => setModal("export")}
              >
                <ArrowDownToLine size={16} />
                내보내기
              </button>
              <button
                className="button primary"
                onClick={() =>
                  stage === 4 ? setModal("export") : go(stage + 1)
                }
              >
                {stage === 4 ? "결과물 다운로드" : "다음 단계로"}
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
          <div className="workflow" aria-label="제작 프로세스">
            {stages.map((s, i) => {
              const complete =
                i === 0
                  ? project.sources.length > 0
                  : i === 1
                    ? project.confirmed
                    : i === 2
                      ? generated
                      : i === 3
                        ? passed === checks.length
                        : false;
              return (
                <button
                  key={s.name}
                  className={`workflow-step ${stage === i ? "current" : ""} ${complete ? "complete" : ""}`}
                  onClick={() => go(i)}
                >
                  <span className="step-number">
                    {complete && stage !== i ? (
                      <Check size={16} />
                    ) : (
                      String(i + 1).padStart(2, "0")
                    )}
                  </span>
                  <span className="step-text">
                    <small>{s.en}</small>
                    <strong>{s.name}</strong>
                  </span>
                  {i < 4 && <ChevronRight className="step-chevron" size={15} />}
                </button>
              );
            })}
          </div>
          <DesignStudio project={project} selectedId={selectedElementId}
            onSelect={id => setSelected(parts.find(p => p.sourceElementId === id)?.id || id)}
            onAddSources={() => inputRef.current?.click()} onDesign={applyDesign} onUndo={undoDesign} onRestore={restored => { setProject(restored); setSelected(""); setStage(0); }} notify={notify}/>
          <div className="workspace-grid">
            <ModelView
              dimensions={d}
              projectName={project.name}
              selected={selected}
              onSelect={onSelect}
              design={project.design}
              providedParts={parts}
              pendingImage={pendingImage}
            />
            <aside className="right-column">
              <section className="readiness-card">
                <div className="card-label">
                  제작 준비도
                  <ShieldCheck size={16} />
                </div>
                <div className="readiness-main">
                  <div className="readiness-number">
                    {progress}
                    <span>%</span>
                  </div>
                  <div>
                    <span className="review-pill">
                      {passed === checks.length
                        ? "검수 기록 완료"
                        : "검토가 필요해요"}
                    </span>
                    <p>
                      {passed} / {checks.length}개 항목 확인
                    </p>
                  </div>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <button className="text-link" onClick={() => go(3)}>
                  검수 항목 살펴보기
                  <ArrowUpRight size={14} />
                </button>
              </section>
              <section className="design-summary">
                <div className="card-heading">
                  <h2>설계 기준</h2>
                  <button aria-label="설계 기준 수정" onClick={() => go(1)}>
                    <SlidersHorizontal size={16} />
                  </button>
                </div>
                {project.design && sceneBounds ? <div className="scene-summary">
                  <span>{project.design.size.mode === "known-reference" ? "입력 기준 1:" + project.design.size.scaleDenominator : "실물 크기 미확인 · 목표 모형 mm"}</span>
                  <b>{sceneBounds.width.toFixed(1)} × {sceneBounds.depth.toFixed(1)} × {sceneBounds.height.toFixed(1)} mm</b>
                  <p>베이스 제외 외형 · 요소 {project.design.elements.length}개 · 부품 {parts.length}개</p>
                  <p>실제 판재 두께 {project.design.fabrication.thicknessMm} mm · kerf 보정 미적용</p>
                  {(() => { const o = project.design.observations[0], source = project.sources.find(s => s.id === o?.sourceId); return source?.url && source.type.startsWith("image/") && o ? <svg role="img" aria-label="모델 비교 원본" width="100%" viewBox={[o.crop.x,o.crop.y,o.crop.width,o.crop.height].join(" ")}><image href={source.url} width={o.pixelWidth} height={o.pixelHeight}/></svg> : null; })()}
                  <p>3D 보기에서 ‘정면도’를 선택해 원본 입면과 비교하세요. 미관찰 후면과 깊이는 보완 가정입니다.</p>
                </div> : <>
                <div className="scale-setting">
                  <span>모형 축척</span>
                  <label>
                    <span>1 :</span>
                    <select
                      aria-label="모형 축척"
                      value={d.scale}
                      onChange={(e) =>
                        updateDimension("scale", Number(e.target.value))
                      }
                    >
                      {[50, 80, 87, 100, 150, 160, 200].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                      {![50, 80, 87, 100, 150, 160, 200].includes(d.scale) && (
                        <option value={d.scale}>{d.scale}</option>
                      )}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                </div>
                <div className="dimension-table">
                  <div className="dimension-table-head">
                    <span>실제 건축물</span>
                    <span>1:{d.scale} 모형</span>
                  </div>
                  {(["width", "depth", "wallHeight"] as const).map((key) => (
                    <div className="dimension-summary-row" key={key}>
                      <span>{dimensionLabels[key]}</span>
                      <b>
                        {d[key].toLocaleString()}
                        <small>mm</small>
                        <ArrowRight size={11} />
                        <em>
                          {(d[key] / d.scale).toFixed(1)}
                          <small>mm</small>
                        </em>
                      </b>
                    </div>
                  ))}
                </div>
                <div className="material-summary">
                  <Layers3 size={16} />
                  <span>
                    자작 합판<b>{d.thickness} mm</b>
                  </span>
                  <span className="muted-badge">
                    {project.physicalConfirmed ? "실물 확인" : "미확인"}
                  </span>
                </div>
                </>}
              </section>
              <div className="next-note">
                <span className="note-icon">
                  <Sparkles size={17} />
                </span>
                <div>
                  <b>좋은 모형의 시작은, 정확한 기준.</b>
                  <p>사진에서 추정한 치수는 원본과 대조한 후 확정해 주세요.</p>
                </div>
              </div>
            </aside>
          </div>
          <section className="process-panel">
            <div className="panel-top">
              <div>
                <span className="eyebrow">
                  STEP {String(stage + 1).padStart(2, "0")}
                </span>
                <h2>
                  {stage === 0
                    ? "건축의 단서를 모으는 곳"
                    : stage === 1
                      ? "모든 부품의 기준이 되는 치수"
                      : stage === 2
                        ? "하나의 건축, 정교한 파츠들"
                        : stage === 3
                          ? "만들기 전에, 한 번 더 확인"
                          : "이제, 손으로 만날 차례"}
                </h2>
              </div>
              <span className="panel-caption">
                {stage === 0
                  ? `${project.sources.length}개 자료 등록됨`
                  : stage === 1
                    ? "실제 치수 입력 · 모형 치수 자동 계산"
                    : stage === 2
                      ? `${parts.length}개 파츠 · 단위 mm`
                      : stage === 3
                        ? "자동 검사 + 사람의 검수"
                        : "모든 결과물은 검토용으로 출력됩니다"}
              </span>
            </div>
            {stage === 0 && (
              <div className="sources-content">
                <div className="sources-top">
                  <div>
                    <h3>참고 자료</h3>
                    <p>사진, 도면, 치수표를 한곳에 모으세요.</p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => inputRef.current?.click()}
                  >
                    <Plus size={15} />
                    자료 추가
                  </button>
                </div>
                <div className="sources-grid">
                  {project.sources.map((s) => (
                    <article className="source-card" key={s.id}>
                      <button
                        className={`source-thumbnail ${s.id === "sample-elevation" ? "elevation-thumb" : ""}`}
                        aria-label={`${s.name} 열기`}
                        onClick={() => {
                          setPreviewSource(s);
                          setModal("source");
                        }}
                      >
                        {s.url && s.type.startsWith("image/") ? (
                          <img src={s.url} alt={s.name} />
                        ) : s.id === "sample-elevation" ? (
                          <ElevationThumb />
                        ) : s.type.includes("image") ? (
                          <FileImage size={31} />
                        ) : s.name.endsWith(".csv") ? (
                          <div className="csv-thumbnail">
                            <span>DIMENSION SCHEDULE</span>
                            {[
                              "건물 너비",
                              "건물 깊이",
                              "벽체 높이",
                              "지붕 높이",
                            ].map((l, i) => (
                              <div key={l}>
                                <span>{l}</span>
                                <b>{[12800, 7200, 3600, 2200][i]}</b>
                                <small>mm</small>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <FileText size={31} />
                        )}
                        <span className="source-kind">
                          {s.sample
                            ? "SAMPLE"
                            : s.name.split(".").pop()?.toUpperCase()}
                        </span>
                      </button>
                      <div className="source-info">
                        <FileImage size={15} />
                        <div>
                          <b title={s.name}>{s.name}</b>
                          <span>
                            {bytes(s.size)} ·{" "}
                            {s.sample
                              ? "예시 자료, 실측 근거 아님"
                              : !s.url && !s.text
                                ? "원본 재첨부 필요"
                                : "원본 검토 대기"}
                          </span>
                        </div>
                        <button
                          title="자료 제거"
                          aria-label={`${s.name} 제거`}
                          onClick={() => {
                            setProject((p) => ({
                              ...p,
                              sources: p.sources.filter((x) => x.id !== s.id),
                              confirmed: false,
                            }));
                            setCandidates([]);
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                  <button
                    className="upload-card"
                    onClick={() => inputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void addFiles(e.dataTransfer.files);
                    }}
                  >
                    <span>
                      <Upload size={22} />
                    </span>
                    <b>자료를 여기에 놓아주세요</b>
                    <small>JPG, PNG, PDF, SVG, DXF, CSV, TXT</small>
                    <small>파일당 최대 10 MB</small>
                  </button>
                </div>
                <div className="analysis-strip">
                  <div className="ai-symbol">
                    <Sparkles size={21} />
                  </div>
                  <div>
                    <b>자료에서 설계의 시작점을 찾아보세요</b>
                    <p>
                      {aiConfigured
                        ? "AI가 판독한 치수는 근거와 함께 제안되며, 직접 확인한 뒤 반영합니다."
                        : "이 버튼은 CSV·TXT의 명시된 치수만 읽습니다. 이미지 형상은 위의 ‘이미지에서 외형 추정’을 사용하세요. ChatGPT 사용량 연동은 별도 검증 전입니다."}
                    </p>
                  </div>
                  <button
                    className="button primary small"
                    disabled={analyzing || !project.sources.length}
                    onClick={() => void analyze()}
                  >
                    {analyzing ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Sparkles size={15} />
                    )}
                    자료 분석
                  </button>
                </div>
                {candidates.length > 0 && (
                  <div className="candidates">
                    <h3>
                      추출된 치수 제안{" "}
                      <span className="review-pill">확정 전</span>
                    </h3>
                    {candidates.map((c, i) => (
                      <div className="candidate" key={`${c.field}-${i}`}>
                        <span>{dimensionLabels[c.field]}</span>
                        <b>{c.value.toLocaleString()} mm</b>
                        <span className="review-pill">
                          {c.confidence || "미확정"}
                        </span>
                        <p>
                          {
                            project.sources.find((s) => s.id === c.sourceId)
                              ?.name
                          }{" "}
                          · {c.evidence}
                        </p>
                      </div>
                    ))}
                    <button
                      className="button primary small"
                      onClick={() => {
                        const next = { ...d };
                        candidates.forEach((c) => {
                          next[c.field] = c.value;
                        });
                        if (!validDimensions(next)) {
                          notify(
                            "제안된 치수가 허용 범위를 벗어납니다. 직접 입력해 주세요.",
                          );
                          return;
                        }
                        update({
                          dimensions: next,
                          confirmed: false,
                          physicalConfirmed: false,
                        });
                        setCandidates([]);
                        go(1);
                        notify(
                          "제안 치수를 반영했습니다. 원본과 대조한 후 확인해 주세요.",
                        );
                      }}
                    >
                      제안 치수 반영
                      <ArrowRight size={14} />
                    </button>
                  </div>
                )}
                <p className="footnote">
                  <ShieldCheck size={13} />
                  원본은 이 브라우저에 보관됩니다. 브라우저 이미지 추정은 외부 AI로 전송하지 않습니다. PDF는 페이지를 이미지로 연 뒤 추정할 수 있습니다. DXF 자동 판독은 지원하지 않습니다.
                </p>
              </div>
            )}
            {stage === 1 && project.design && <div className="scene-reference">이 모델의 기준은 위의 목표 크기·건물 요소·제작 설정입니다. 요소를 선택해 수정하면 화면과 도안이 함께 바뀝니다. 원본 대조는 위의 입면 투영과 근거를 확인한 뒤 검수에서 기록하세요.</div>}
            {stage === 1 && !project.design && (
              <div className="dimensions-content">
                <div className="dimensions-section">
                  <div className="section-description">
                    <span className="section-icon">
                      <Ruler size={19} />
                    </span>
                    <h3>건축물 치수</h3>
                    <p>
                      실제 건축물의 치수를 입력하세요.
                      <br />
                      확인된 원본의 치수를 기준으로 합니다.
                    </p>
                    <span
                      className={
                        project.confirmed ? "verified-label" : "estimated-label"
                      }
                    >
                      {project.confirmed ? (
                        <Check size={12} />
                      ) : (
                        <span className="tiny-dot" />
                      )}
                      {project.confirmed
                        ? "사용자 확인 완료"
                        : "추정 치수 · 확인 필요"}
                    </span>
                  </div>
                  <div className="fields-grid">
                    {(
                      [
                        "width",
                        "depth",
                        "wallHeight",
                        "roofRise",
                        "windowWidth",
                        "windowHeight",
                        "doorWidth",
                        "doorHeight",
                      ] as const
                    ).map((key) => (
                      <label className="dimension-field" key={key}>
                        <span>{dimensionLabels[key]}</span>
                        <div>
                          <input
                            aria-label={dimensionLabels[key]}
                            type="number"
                            min="1"
                            max="100000"
                            step="10"
                            value={d[key]}
                            onChange={(e) =>
                              updateDimension(key, Number(e.target.value))
                            }
                          />
                          <small>mm</small>
                        </div>
                        <em>모형 {(d[key] / d.scale).toFixed(2)} mm</em>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="dimensions-section materials-section">
                  <div className="section-description">
                    <span className="section-icon">
                      <Layers3 size={18} />
                    </span>
                    <h3>재료와 제작 여유</h3>
                    <p>
                      모형에 사용할 실제 재료 값입니다.
                      <br />
                      축척에 따라 줄어들지 않습니다.
                    </p>
                  </div>
                  <div className="fields-grid materials-fields">
                    {(["thickness", "kerf", "clearance"] as const).map(
                      (key) => (
                        <label className="dimension-field" key={key}>
                          <span>{dimensionLabels[key]}</span>
                          <div>
                            <input
                              aria-label={dimensionLabels[key]}
                              type="number"
                              min={key === "thickness" ? 0.5 : 0}
                              max={
                                key === "thickness"
                                  ? 10
                                  : key === "kerf"
                                    ? 1
                                    : 2
                              }
                              step="0.05"
                              value={d[key]}
                              onChange={(e) =>
                                updateDimension(key, Number(e.target.value))
                              }
                            />
                            <small>mm</small>
                          </div>
                          <em>
                            {key === "kerf"
                              ? "기록값 · CAM에서 보정"
                              : key === "clearance"
                                ? "창틀 외곽 한쪽 기준"
                                : "벽체·지붕판에 적용"}
                          </em>
                        </label>
                      ),
                    )}
                  </div>
                </div>
                {issues.length > 0 && (
                  <div className="warning-box">
                    <TriangleAlert size={17} />
                    <span>{issues.join(" ")}</span>
                  </div>
                )}
                <div className="confirmation-bar">
                  <label>
                    <input
                      type="checkbox"
                      checked={project.confirmed}
                      disabled={!project.sources.length}
                      onChange={(e) => update({ confirmed: e.target.checked })}
                    />
                    <span>
                      원본 자료와 입력 치수의 출처·단위를 대조했습니다.
                      {!project.sources.length ? " (자료 등록 필요)" : ""}
                    </span>
                  </label>
                  <button
                    className="button primary small"
                    onClick={() => go(2)}
                  >
                    부품 모델링으로
                    <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            )}
            {stage === 2 && (
              <div className="parts-content">
                <div className="parts-actions">
                  <div className="filter-tabs">
                    {[
                      ["all", "전체"],
                      ["wall", "벽체"],
                      ["roof", "지붕"],
                      ["window", "창틀·문"],
                      ["glass", "투명판"],
                      ["base", "베이스"],
                    ].map(([id, name]) => (
                      <button
                        className={filter === id ? "active" : ""}
                        key={id}
                        onClick={() => setFilter(id)}
                      >
                        {name}
                        {id === "all" && <span>{parts.length}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="part-search">
                    <Search size={14} />
                    <input
                      placeholder="파츠 검색"
                      aria-label="파츠 검색"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <button
                    className="button primary small"
                    onClick={generate}
                    disabled={issues.length > 0}
                  >
                    <Box size={15} />
                    {generated ? "부품 다시 생성" : "부품 생성"}
                  </button>
                </div>
                {!generated && (
                  <div className="inline-notice">
                    <CircleHelp size={15} />
                    현재 설계 기준의 미리보기입니다. ‘부품 생성’으로 내보낼
                    버전을 확정하세요.
                  </div>
                )}
                <div className="parts-table-wrap">
                  <table className="parts-table">
                    <thead>
                      <tr>
                        <th>파츠 번호</th>
                        <th>부품명</th>
                        <th>모형 크기 (mm)</th>
                        <th>재료</th>
                        <th>두께</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleParts.map((p) => (
                        <tr
                          key={p.id}
                          className={selected === p.id ? "selected" : ""}
                          onClick={() => setSelected(p.id)}
                        >
                          <td>
                            <span className={`part-dot ${p.group}`} />
                            {p.id}
                          </td>
                          <td>{p.name}</td>
                          <td>
                            {Math.max(...p.outline.map((v) => v[0])).toFixed(2)}{" "}
                            ×{" "}
                            {Math.max(...p.outline.map((v) => v[1])).toFixed(2)}
                          </td>
                          <td>{p.material}</td>
                          <td>{p.thickness} mm</td>
                          <td>
                            <button
                              aria-label={`${p.id} STL 다운로드`}
                              title="개별 파츠 STL 다운로드"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!generated) {
                                  notify("부품을 먼저 생성해 주세요.");
                                  return;
                                }
                                download(
                                  stlPart(p),
                                  `${p.id}_검토용.stl`,
                                  "model/stl",
                                );
                                notify(`${p.id} 부품 STL을 내보냈습니다.`);
                              }}
                            >
                              <ArrowDownToLine size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visibleParts.length && (
                    <p className="empty-state">
                      일치하는 파츠가 없습니다. 검색어나 설계 기준을 확인해
                      주세요.
                    </p>
                  )}
                </div>
                <div className="parts-bottom">
                  <span>
                    <span className="tiny-dot" />
                    부품별 STL · 로컬 좌표 · mm 단위
                  </span>
                  <button className="text-link" onClick={() => go(3)}>
                    검수로 이동
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}
            {stage === 3 && (
              <div className="review-content">
                <div className="review-overview">
                  <div className="review-symbol">
                    <ClipboardCheck size={26} />
                  </div>
                  <div>
                    <h3>
                      {passed === checks.length
                        ? "등록된 검수 항목을 모두 확인했습니다"
                        : "한 번의 확인이, 제작의 완성도를 바꿉니다"}
                    </h3>
                    <p>
                      자동 검사는 수치 규칙을 확인합니다. 원본 대조와 실제 재료
                      시험은 사람이 확인해야 합니다.
                    </p>
                  </div>
                  <span className="review-total">
                    {passed}
                    <small> / {checks.length}</small>
                  </span>
                </div>
                <div className="check-list">
                  {checks.map((c) => (
                    <div className={`check-row ${c.status}`} key={c.id}>
                      {c.status === "pass" ? (
                        <CheckCircle2 size={21} />
                      ) : c.status === "fail" ? (
                        <TriangleAlert size={21} />
                      ) : (
                        <CircleHelp size={21} />
                      )}
                      <div>
                        <b>{c.name}</b>
                        <p>{c.detail}</p>
                      </div>
                      <span>
                        {c.status === "pass"
                          ? "확인 완료"
                          : c.status === "fail"
                            ? "수정 필요"
                            : "확인 필요"}
                      </span>
                      {c.id === "source" && !project.confirmed && (
                        <button className="text-link" onClick={() => go(1)}>
                          기준 확인
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                      {c.id === "generation" && !generated && (
                        <button className="text-link" onClick={generate}>
                          부품 생성
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {project.design && <label className="design-source-confirmation"><input type="checkbox" checked={project.confirmed} onChange={e => update({ confirmed: e.target.checked })}/>원본 입면과 관찰·추정·설계 보완 근거를 대조했습니다. 실측 또는 미관찰 후면 검증을 뜻하지 않습니다.</label>}
                <div className="physical-review">
                  <h3>실물 시험 기록</h3>
                  <p className="footnote">
                    기록은 보존됩니다. 치수 변경 시 확인 상태가 초기화되므로
                    다시 검토해 주세요.
                  </p>
                  <textarea
                    aria-label="실물 시험 기록"
                    placeholder="사용한 재료, 실측 두께, 끼움 상태와 수정 사항을 기록하세요."
                    value={project.physicalNote}
                    onChange={(e) =>
                      update({
                        physicalNote: e.target.value,
                        physicalConfirmed: false,
                      })
                    }
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={project.physicalConfirmed}
                      disabled={!project.physicalNote.trim()}
                      onChange={(e) =>
                        update({ physicalConfirmed: e.target.checked })
                      }
                    />
                    시험 가공과 조립 결과를 확인했습니다.
                  </label>
                </div>
                <p className="footnote">
                  <TriangleAlert size={13} />
                  전체 3D 간섭, 구조 강도, 자동 연결부 설계는 이 버전의 검수
                  범위에 포함되지 않습니다. 모든 내보내기 파일은 검토용입니다.
                </p>
              </div>
            )}
            {stage === 4 && (
              <div className="exports-content">
                <ExportOptions onExport={exportFile} />
                <div className="export-note">
                  <FileCheck2 size={19} />
                  <div>
                    <b>설계 기준부터 검수 기록까지, 함께 전달하세요.</b>
                    <p>
                      프로젝트 JSON에 치수·부품 목록·출처·검수 상태가
                      포함됩니다. 문서는 브라우저의 인쇄 기능으로 PDF 저장할 수
                      있습니다.
                    </p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => window.print()}
                  >
                    <FileText size={15} />
                    검수 문서 인쇄
                  </button>
                </div>
              </div>
            )}
          </section>
          <div className="workspace-footer">
            <span>
              <span className="tiny-dot" />
              차곡차곡 쌓인 기록이, 다음 제작의 기준이 됩니다.
            </span>
            <span>
              TRADIATIVE STUDIO <i />
              v0.2
            </span>
          </div>
          <section className="print-report">
            <h1>{project.name} · 설계 검수 기록</h1>
            <p>
              검토용 / {project.design ? (project.design.size.mode === "known-reference" ? "입력 기준 1:" + project.design.size.scaleDenominator : "목표 모형 mm · 실물 축척 미확인") : "1:" + d.scale} /{" "}
              {new Date(project.updatedAt).toLocaleString("ko-KR", {
                timeZone: "Asia/Seoul",
              }) + " KST"}
            </p>
            <h2>설계 기준</h2>
            <table>
              <tbody>
                {Object.entries(project.design ? { 목표폭: project.design.size.targetWidthMm, 판재두께: project.design.fabrication.thicknessMm, 형상버전: project.design.revision } : d).map(([key, value]) => (
                  <tr key={key}>
                    <th>{dimensionLabels[key as keyof Dimensions] || key}</th>
                    <td>
                      {value} {key === "scale" ? "" : "mm"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2>참고 자료</h2>
            {project.sources.map((s) => (
              <p key={s.id}>
                {s.name} {s.sample ? "(샘플·실측 근거 아님)" : ""}
              </p>
            ))}
            <h2>검수 결과</h2>
            {checks.map((c) => (
              <p key={c.id}>
                <b>
                  {c.name}:{" "}
                  {c.status === "pass"
                    ? "확인 완료"
                    : c.status === "fail"
                      ? "수정 필요"
                      : "확인 필요"}
                </b>
                <br />
                {c.detail}
              </p>
            ))}
            <h2>부품 목록</h2>
            <table>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{p.name}</td>
                    <td>{p.material}</td>
                    <td>{p.thickness} mm</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              kerf 보정은 적용되지 않았습니다. 전체 3D 간섭·강도·연결부 적합성은
              별도 검토해야 합니다.
            </p>
          </section>
        </main>
      </div>
      <input
        className="hidden"
        ref={inputRef}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,.dxf,.csv,.txt"
        onChange={(e) => void addFiles(e.target.files)}
      />
      <input
        className="hidden"
        ref={importRef}
        type="file"
        accept=".json"
        onChange={(e) => void importProject(e.target.files?.[0])}
      />
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button aria-label="알림 닫기" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "export"
                ? "결과물 내보내기"
                : modal === "new"
                  ? "새 프로젝트"
                  : modal === "guide"
                    ? "작업 가이드"
                    : modal === "source"
                      ? "참고 자료 보기"
                      : "작업실 설정"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="닫기"
              onClick={() => setModal(null)}
            >
              <X size={19} />
            </button>
            {modal === "export" && (
              <>
                <span className="eyebrow">FROM DIGITAL TO PHYSICAL</span>
                <h2>다음 작업으로 이어지는 파일</h2>
                <p className="modal-description">
                  {project.name} · {project.design ? (project.design.size.mode === "known-reference" ? "입력 기준 1:" + project.design.size.scaleDenominator : "목표 폭 " + project.design.size.targetWidthMm + " mm") : "1:" + d.scale} · {parts.length}개 파츠
                </p>
                {(!project.confirmed || !generated) && (
                  <div className="warning-box">
                    <TriangleAlert size={17} />
                    <span>
                      {!generated
                        ? "현재 치수로 부품을 먼저 생성해야 도안·모델을 내보낼 수 있습니다."
                        : "원본 치수 대조가 완료되지 않았습니다. 파일은 검토용으로만 사용하세요."}
                    </span>
                  </div>
                )}
                <ExportOptions onExport={exportFile} />
                <button
                  className="button secondary wide"
                  onClick={() => {
                    setModal(null);
                    go(4);
                  }}
                >
                  전체 결과물·검수 문서 보기
                  <ArrowRight size={15} />
                </button>
              </>
            )}
            {modal === "new" && (
              <>
                <span className="eyebrow">A NEW CHAPTER</span>
                <h2>어떤 건축을 기억할까요?</h2>
                <p className="modal-description">
                  현재 프로젝트는 JSON으로 백업한 뒤 새 작업을 시작합니다. 원본
                  사진·도면 파일은 JSON에 포함되지 않습니다.
                </p>
                <label className="new-name">
                  프로젝트 이름
                  <input
                    autoFocus
                    placeholder="예: 군산 구 세관 본관"
                    maxLength={100}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createProject();
                    }}
                  />
                </label>
                <button
                  className="button primary wide"
                  disabled={!newName.trim()}
                  onClick={createProject}
                >
                  <Plus size={16} />
                  프로젝트 시작하기
                </button>
                <button
                  className="text-link import-link"
                  onClick={() => {
                    setModal(null);
                    importRef.current?.click();
                  }}
                >
                  <FileJson size={15} />
                  기존 프로젝트 JSON 가져오기
                </button>
              </>
            )}
            {modal === "guide" && (
              <>
                <span className="eyebrow">THE MAKING PROCESS</span>
                <h2>건축 모형을 만드는 다섯 단계</h2>
                <div className="guide-list">
                  {stages.map((s, i) => (
                    <button
                      key={s.name}
                      onClick={() => {
                        go(i);
                        setModal(null);
                      }}
                    >
                      <span>0{i + 1}</span>
                      <div>
                        <b>{s.name}</b>
                        <p>
                          {
                            [
                              "사진·도면을 모으고 CSV·TXT 치수나 AI 제안을 확인합니다.",
                              "실제 치수를 mm로 통일하고 축척·재료 두께를 설정합니다.",
                              "현재 설계 기준으로 부품을 생성하고 개별 형상을 확인합니다.",
                              "자동 수치 검사와 원본·실물 검수 기록을 확인합니다.",
                              "SVG·DXF·STL·프로젝트 JSON을 내려받습니다.",
                            ][i]
                          }
                        </p>
                      </div>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
                <div className="guide-note">
                  이 버전은 직사각형 평면과 박공지붕의 파라메트릭 작업용입니다.
                  사진만으로 임의 건축물을 자동 복원하거나 가공 적합성을
                  보증하지 않습니다.
                </div>
              </>
            )}
            {modal === "source" && previewSource && (
              <>
                <span className="eyebrow">REFERENCE ARCHIVE</span>
                <h2 className="source-modal-title">{previewSource.name}</h2>
                <p className="modal-description">
                  {previewSource.sample
                    ? "샘플 자료 · 실제 실측 근거가 아닙니다"
                    : `${bytes(previewSource.size)} · 원본 대조용 자료`}
                </p>
                <div className="source-full-preview">
                  {previewSource.id === "sample-elevation" ? (
                    <ElevationThumb />
                  ) : previewSource.url &&
                    previewSource.type.startsWith("image/") ? (
                    <img src={previewSource.url} alt={previewSource.name} />
                  ) : previewSource.url &&
                    previewSource.type === "application/pdf" ? (
                    <iframe
                      src={previewSource.url}
                      title={previewSource.name}
                    />
                  ) : previewSource.text &&
                    !previewSource.text.startsWith("data:") ? (
                    <pre>{previewSource.text.slice(0, 18000)}</pre>
                  ) : (
                    <p>
                      이 자료의 미리보기가 없습니다. 원본 파일을 다시 첨부하거나
                      내려받아 확인해 주세요.
                    </p>
                  )}
                </div>
                {previewSource.url && (
                  <a
                    className="button secondary wide"
                    href={previewSource.url}
                    download={previewSource.name}
                  >
                    <ArrowDownToLine size={16} />
                    원본 파일 다운로드
                  </a>
                )}
              </>
            )}
            {modal === "settings" && (
              <>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h2>작업실 설정</h2>
                <div className="settings-row">
                  <span>데이터 저장</span>
                  <b>이 브라우저의 로컬 저장소</b>
                </div>
                <div className="settings-row">
                  <span>사진 AI 분석</span>
                  <b
                    className={
                      aiConfigured ? "verified-label" : "estimated-label"
                    }
                  >
                    {aiConfigured ? "별도 API 경로 허용됨·실제 호출 별도 확인" : "ChatGPT 연동 미검증"}
                  </b>
                </div>
                <p className="settings-description">
                  ChatGPT 구독 사용량 연동은 로그인·모델 호출 완료 검증 전입니다. 브라우저 이미지 추정은 API 키 없이 작동합니다. 별도 과금 API는 명시적으로 선택·허용하기 전 활성화하지 않습니다.
                </p>
                <button
                  className="button secondary wide"
                  onClick={() => exportFile("json")}
                >
                  <ArrowDownToLine size={16} />
                  현재 프로젝트 백업
                </button>
                <button
                  className="button secondary wide"
                  onClick={() => {
                    setModal(null);
                    importRef.current?.click();
                  }}
                >
                  <Upload size={16} />
                  프로젝트 파일 가져오기
                </button>
                <p className="footnote">
                  원본 파일은 이 브라우저에 보관됩니다. 다른 기기에서 JSON을
                  가져오면 원본을 다시 첨부해야 합니다. 계정 로그인·서버
                  프로젝트 보관은 아직 지원하지 않습니다.
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ExportOptions({
  onExport,
}: {
  onExport: (format: "svg" | "dxf" | "stl" | "json") => void;
}) {
  return (
    <div className="export-options">
      {[
        {
          id: "svg",
          name: "벡터 도안",
          ext: "SVG",
          detail: "mm 단위의 윤곽·개구부·부품 번호",
          icon: Ruler,
        },
        {
          id: "dxf",
          name: "CAD 도안",
          ext: "DXF",
          detail: "닫힌 폴리라인 · 부품별 레이어",
          icon: Layers3,
        },
        {
          id: "stl",
          name: "3D 조립 모델",
          ext: "STL",
          detail: "부품을 조립한 검토용 3D 메시",
          icon: Box,
        },
        {
          id: "json",
          name: "프로젝트 데이터",
          ext: "JSON",
          detail: "설계 기준·부품 치수·검수 기록",
          icon: FileJson,
        },
      ].map((f) => {
        const Icon = f.icon;
        return (
          <button
            key={f.id}
            onClick={() => onExport(f.id as "svg" | "dxf" | "stl" | "json")}
          >
            <span className="export-icon">
              <Icon size={23} />
            </span>
            <div>
              <b>
                {f.name}
                <span>{f.ext}</span>
              </b>
              <p>{f.detail}</p>
            </div>
            <ArrowDownToLine size={17} />
          </button>
        );
      })}
    </div>
  );
}
function ElevationThumb() {
  return (
    <svg viewBox="0 0 340 150" aria-label="샘플 건축 입면도">
      <defs>
        <pattern
          id="drawing-grid"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <path d="M12 0H0V12" fill="none" stroke="#d9d5c7" strokeWidth=".3" />
        </pattern>
      </defs>
      <rect width="340" height="150" fill="url(#drawing-grid)" />
      <g fill="none" stroke="#6f7668" strokeWidth=".8">
        <path d="M35 64H305V113H35zM24 64L47 38H293L316 64ZM29 68H311M35 117H305" />
        <path d="M154 113V74H185V113M170 74V113" />
        {[54, 102, 207, 255].map((x) => (
          <g key={x}>
            <rect x={x} y="78" width="25" height="25" />
            <path d={`M${x + 12.5} 78V103M${x} 90.5h25`} />
          </g>
        ))}
        <path d="M35 128H305M35 124V132M305 124V132M20 64V113M16 64h8M16 113h8" />
      </g>
      <text
        x="170"
        y="141"
        textAnchor="middle"
        fontSize="8"
        fill="#7c806e"
        fontFamily="monospace"
      >
        12,800 mm · SAMPLE ELEVATION
      </text>
      <text x="160" y="61" fontSize="8" fill="#66715b">
        임피역
      </text>
    </svg>
  );
}
