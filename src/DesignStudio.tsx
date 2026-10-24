import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Play, Square, Undo2, LockKeyhole, UnlockKeyhole, Download, FolderOpen, Sparkles, AlertCircle } from "lucide-react";
import type { Project, Source } from "./engine";
import { readSourceFile } from "./sourceStore";
import { DEFAULT_FABRICATION, PROVENANCE_LABELS, type BuildingDesign, type EstimateOptions, type Rect, type SizeSettings } from "./design/types";
import { bounds, validateDesign } from "./design/geometry";
import { applyInstruction, editElement } from "./design/editing";
import { estimateInWorker, imagePixels } from "./design/client";
import { compareFront } from "./design/estimate";
import { downloadBytes, packageProject, restorePackage } from "./design/archive";
import "./design/studio.css";
import { aiReference, connectionAction, connectionStatus, DISCONNECTED, requestAiDesign, type AiConnection } from "./design/aiClient";

type Props = {
  project: Project;
  selectedId: string;
  onSelect: (id: string) => void;
  onDesign: (scene: BuildingDesign, label: string) => void;
  onUndo: () => void;
  onRestore: (project: Project) => void;
  notify: (message: string) => void;
  onAddSources: () => void;
};

async function sourceBlob(source: Source) {
  const blob = await readSourceFile(source.id);
  if (!blob) throw new Error("원본 자료를 이 브라우저에서 찾지 못했습니다. 자료를 다시 첨부해 주세요.");
  return blob;
}
export default function DesignStudio({ project, selectedId, onSelect, onDesign, onUndo, onRestore, notify, onAddSources }: Props) {
  const [sourceId, setSourceId] = useState("");
  const [targetWidth, setTargetWidth] = useState(project.design?.size.targetWidthMm || 300);
  const [sizeMode, setSizeMode] = useState<SizeSettings["mode"]>(project.design?.size.mode || "target-width");
  const [realWidth, setRealWidth] = useState(17140);
  const [denominator, setDenominator] = useState(80);
  const [projection, setProjection] = useState<EstimateOptions["projection"]>("orthographic");
  const [completion, setCompletion] = useState<EstimateOptions["completion"]>("complete");
  const [depthRatio, setDepthRatio] = useState(0.35);
  const [iterations, setIterations] = useState(1);
  const [thickness, setThickness] = useState(DEFAULT_FABRICATION.thicknessMm);
  const [crop, setCrop] = useState<Rect>();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("준비");
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<AiConnection>(DISCONNECTED);
  const [model, setModel] = useState("");
  const [aiSourceIds, setAiSourceIds] = useState<string[]>([]);
  const [aiInstruction, setAiInstruction] = useState("");
  const [overlay, setOverlay] = useState(true);
  const [proofFilter, setProofFilter] = useState("all");
  const [instruction, setInstruction] = useState("");
  const [moveX, setMoveX] = useState(0);
  const [moveY, setMoveY] = useState(0);
  const [newWidth, setNewWidth] = useState(0);
  const [newHeight, setNewHeight] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pdfPreview, setPdfPreview] = useState<{ sourceId: string; page: number; blob: Blob; url: string }>();
  const controller = useRef<AbortController | null>(null);
  const best = useRef<BuildingDesign | undefined>(undefined);
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const sources = project.sources.filter(s => !s.sample && (/^image\/(png|jpeg|webp)$/.test(s.type) || /\.pdf$/i.test(s.name)));
  const source = sources.find(s => s.id === sourceId);
  const pdf = source?.name.toLowerCase().endsWith(".pdf");
  const preview = pdf ? pdfPreview?.sourceId === sourceId ? pdfPreview.url : undefined : source?.url;
  const scene = project.design, element = scene?.elements.find(e => e.id === selectedId);
  const observation = scene?.observations.find(o => o.view === "front" && o.sourceId === sourceId && (!pdf || o.page === pdfPreview?.page));
  const filtered = scene?.elements.filter(e => proofFilter === "all" || e.provenance === proofFilter) || [];
  const issues = scene ? validateDesign(scene) : [];
  useEffect(() => {
    if (!sources.some(s => s.id === sourceId)) setSourceId(sources[0]?.id || "");
  }, [project.sources, sourceId]); // Source URLs are restored asynchronously from IndexedDB.
  useEffect(() => { setCrop(undefined); setError(""); controller.current?.abort(); }, [sourceId]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => () => { if (pdfPreview) URL.revokeObjectURL(pdfPreview.url); }, [pdfPreview]);
  useEffect(() => {
    if (!element) return;
    const b = bounds(element.outline); setNewWidth(b.width); setNewHeight(b.height); setMoveX(0); setMoveY(0);
  }, [selectedId, element]);
  async function refreshConnection() { const c=await connectionStatus().catch(()=>DISCONNECTED);setConnection(c);setModel(current=>c.plan?.models.some(m=>m.slug===current)?current:c.plan?.models[0]?.slug||""); }
  useEffect(() => { void refreshConnection(); }, []);
  useEffect(() => { setAiSourceIds(current => current.filter(id=>sources.some(s=>s.id===id))); }, [project.sources]);
  async function connect(action: "login"|"models"|"logout") {
    if(!connection.csrf)return;
    const popup=action==="login"?window.open("about:blank","_blank"):null;
    if(popup)popup.opener=null;
    try { const data=await connectionAction(action,connection.csrf);if(action==="login"){if(!data.url?.startsWith("https://auth.openai.com/api/accounts/authorize?"))throw new Error("공식 로그인 주소가 아닙니다.");if(popup)popup.location.href=data.url;else window.location.assign(data.url);}else {await refreshConnection();if(data.message)notify(data.message);} }
    catch(e){popup?.close();setError(e instanceof Error?e.message:"연결 실패");}
  }
  async function runAi() {
    const chosen=sources.filter(s=>aiSourceIds.includes(s.id));
    if(!chosen.length){setError("AI에 전달할 같은 건물의 자료를 선택하세요.");return;}
    const abort=new AbortController();controller.current=abort;setBusy(true);setError("");setStage("AI에 보낼 선택 자료 준비 중");
    try{
      const references=await Promise.all(chosen.map(s=>aiReference(s,s.name.toLowerCase().endsWith(".pdf")&&pdfPreview?.sourceId===s.id?{blob:pdfPreview.blob,page:pdfPreview.page}:undefined)));
      if(abort.signal.aborted)throw new DOMException("취소됨","AbortError");
      const size:SizeSettings=sizeMode==="known-reference"?{mode:sizeMode,targetWidthMm:realWidth/denominator,realWidthMm:realWidth,scaleDenominator:denominator}:{mode:sizeMode,targetWidthMm:targetWidth};
      const options:EstimateOptions={sourceId:chosen[0].id,size,fabrication:{...DEFAULT_FABRICATION,thicknessMm:thickness},projection,completion,depthRatio,maxIterations:Math.min(3,iterations),maxDurationMs:90000};
      setStage("GPT 이미지 해석·구조 생성·수치 검사 중");
      const result=await requestAiDesign(connection,model,references,options,scene,aiInstruction,abort.signal);
      onDesign(result,"실제 GPT 이미지 설계");setStage("GPT 응답 완료·형상 검사 통과·원본 대조 필요");await refreshConnection();
    }catch(e){const cancelled=e instanceof Error&&e.name==="AbortError";setStage(cancelled?"AI 작업 취소·이전 모델 보존":"AI 작업 실패·이전 모델 보존");setError(cancelled?"취소했습니다. 이전 모델을 보존했습니다.":e instanceof Error?e.message:"AI 요청 실패");await refreshConnection();}
    finally{setBusy(false);controller.current=null;}
  }
  async function run() {
    if (!source) { setError("사진 또는 PDF 자료를 먼저 추가해 주세요."); return; }
    setBusy(true); setError(""); setStage("이미지 픽셀 읽는 중"); best.current = undefined;
    const abort = new AbortController(); controller.current = abort;
    try {
      const blob = pdf ? pdfPreview?.sourceId === sourceId ? pdfPreview.blob : undefined : await sourceBlob(source);
      if (!blob) throw new Error("PDF 페이지를 먼저 이미지로 열어 주세요.");
      const pixels = await imagePixels(blob);
      if (abort.signal.aborted) throw new DOMException("취소됨", "AbortError");
      const size: SizeSettings = sizeMode === "known-reference"
        ? { mode: sizeMode, targetWidthMm: realWidth / denominator, realWidthMm: realWidth, scaleDenominator: denominator }
        : { mode: sizeMode, targetWidthMm: targetWidth };
      const options: EstimateOptions = {
        sourceId, page: pdf ? pdfPreview?.page : undefined, size, fabrication: { ...DEFAULT_FABRICATION, thicknessMm: thickness },
        crop: crop ? { x: crop.x * pixels.width, y: crop.y * pixels.height, width: crop.width * pixels.width, height: crop.height * pixels.height } : undefined,
        projection, completion, depthRatio, maxIterations: iterations, maxDurationMs: 15000,
      };
      setStage("윤곽·개구부 추정 중");
      const result = await estimateInWorker(pixels, options, scene, abort.signal, partial => {
        best.current = partial; setStage("형상 검사·자동 보완 " + partial.run!.attempts.length + "/" + iterations);
      });
      onDesign(result, "이미지 외형 추정");
      setStage(result.run?.state === "limited" ? "한도 종료·미해결 항목 있음" : "검토용 결과 생성");
      notify("관찰 입면과 추정·설계 보완 요소를 생성했습니다. 원본과 비교해 주세요.");
    } catch (e) {
      const cancelled = e instanceof Error && e.name === "AbortError";
      if (best.current) {
        const partial = structuredClone(best.current as BuildingDesign);
        if (partial.run) { partial.run.state = cancelled ? "cancelled" : "limited"; partial.run.finishedAt = new Date().toISOString(); }
        onDesign(partial, cancelled ? "중단 전 최선의 결과" : "한도 전 최선의 결과");
      }
      setStage(cancelled ? "취소됨" : "실패·이전 결과 보존");
      setError(cancelled ? "작업을 취소했습니다. 생성된 중간 결과가 있으면 보존했습니다." : e instanceof Error ? e.message : "추정에 실패했습니다.");
    } finally { controller.current = null; setBusy(false); }
  }
  async function openPdf() {
    if (!source) return;
    setError(""); setStage("PDF 페이지 처리 중"); setBusy(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const { pdfPageImage } = await import("./design/pdf");
      const result = await pdfPageImage(await sourceBlob(source), pageNumber, abort.signal);
      setPdfPreview({ sourceId, page: pageNumber, blob: result.blob, url: URL.createObjectURL(result.blob) });
      setCrop(undefined); setStage("PDF " + pageNumber + "/" + result.pageCount + " 페이지 준비");
    } catch (e) { const cancelled = e instanceof Error && e.name === "AbortError"; setError(e instanceof Error ? e.message : "PDF 처리 실패"); setStage(cancelled ? "취소됨" : "PDF 처리 실패"); }
    finally { controller.current = null; setBusy(false); }
  }
  function cropPoint(e: PointerEvent) {
    const b = imageRef.current?.getBoundingClientRect();
    return b ? { x: Math.max(0, Math.min(1, (e.clientX - b.x) / b.width)), y: Math.max(0, Math.min(1, (e.clientY - b.y) / b.height)) } : null;
  }
  function cropEnd(e: PointerEvent) {
    const a = startPoint.current, b = cropPoint(e); startPoint.current = null;
    if (!a || !b || busy) return;
    const next = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    if (next.width > 0.04 && next.height > 0.04) setCrop(next);
  }
  async function backup() {
    try { downloadBytes(await packageProject(project), project.name + "_원본포함_백업.zip"); notify("원본 자료·형상·근거·이력을 ZIP으로 내보냈습니다."); }
    catch (e) { setError(e instanceof Error ? e.message : "백업 실패"); }
  }
  async function restore(file: File | undefined) {
    if (!file) return;
    controller.current?.abort();
    try {
      // Preserve a portable metadata backup before replacing the active project.
      await backupBeforeRestore();
      const restored = await restorePackage(new Uint8Array(await file.arrayBuffer()));
      onRestore(restored); setStage("백업 복원 완료·검토 필요"); notify("원본과 형상·근거를 복원했습니다. 기존 원본은 덮어쓰지 않았습니다.");
    } catch (e) { setError(e instanceof Error ? e.message : "복원 실패"); }
    finally { if (zipInput.current) zipInput.current.value = ""; }
  }
  async function loadCase() {
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
    try {
      await backupBeforeRestore();
      const r = await fetch(import.meta.env.BASE_URL + "cases/impi-v3.zip", { signal: abort.signal });
      if (!r.ok) throw new Error("검토 사례 파일을 열지 못했습니다.");
      const restored = await restorePackage(new Uint8Array(await r.arrayBuffer()));
      if (abort.signal.aborted) throw new DOMException("취소됨", "AbortError");
      onRestore(restored); setStage("임피역 도면 검토 사례 · GPT API 자동생성 아님");
      notify("실제 공개 도면을 대조해 구성한 검토 사례입니다. 단순화한 부분은 근거와 제약을 확인하세요.");
    } catch (e) { setError(e instanceof Error ? e.message : "사례 열기 실패"); }
    finally { setBusy(false); controller.current = null; }
  }
  async function backupBeforeRestore() {
    if (!project.sources.some(s => !s.sample) && !project.design) return;
    downloadBytes(await packageProject(project), project.name + "_가져오기전_백업.zip");
  }
  function change(action: () => BuildingDesign, label: string) {
    try { onDesign(action(), label); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "요소 수정 실패"); }
  }
  const obsCrop = observation?.crop;
  const front = scene?.elements.find(e => e.kind === "wall" && e.provenance === "observed");
  const comparison = scene?.run?.engine === "local-image-estimator" ? compareFront(scene) : undefined;
  function projectionPath(poly: Array<[number, number]>) {
    if (!scene || !observation || !obsCrop) return "";
    const pixelToMm = scene.size.targetWidthMm / (obsCrop.width - 1);
    return poly.map((p, i) => (i ? "L" : "M") + (obsCrop.x + p[0] / pixelToMm) + "," + (obsCrop.y + obsCrop.height - 1 - p[1] / pixelToMm)).join(" ") + " Z";
  }
  return <section className="design-studio" aria-label="이미지 추정·자동 보완">
    <div className="design-studio-heading"><div><span className="eyebrow">IMAGE → BUILDING ELEMENTS</span><h2>이미지 추정·자동 보완</h2><p>보이는 윤곽과 창호를 개별 요소로 만들고, 보이지 않는 깊이와 뒷면은 근거를 남겨 보완합니다.</p></div>
      <div className="archive-actions"><button className="button secondary small" disabled={busy} onClick={() => void loadCase()}>임피역 도면 검토 사례 열기</button><button className="button secondary small" onClick={() => void backup()}><Download size={15}/>원본 포함 백업</button><button className="button secondary small" disabled={busy} onClick={() => zipInput.current?.click()}><FolderOpen size={15}/>백업 ZIP 가져오기</button><input ref={zipInput} type="file" accept=".zip" hidden onChange={e => void restore(e.target.files?.[0])}/></div></div>
    <div className="connection-banner" role="status"><Sparkles size={18}/><div><b>{connection.label}</b><p>{connection.reason}</p><small>남은 구독 사용량: 조회하지 못함 · 실제 AI 요청: {connection.actualRequestVerified ? "완료 검증됨" : "미검증"} · 외부 검색: 미연결</small></div></div>
    {connection.plan?.lastCompleted&&<p className="source-version-note">최근 응답 완료: {connection.plan.lastCompleted.model} · {connection.plan.lastCompleted.at} · 형상 검사 {connection.plan.lastCompleted.validDesign?"통과":"실패"}. {model!==connection.plan.lastCompleted.model?"현재 선택 모델의 실제 이미지 처리는 아직 확인하지 않았습니다.":"모델 재현 품질과 제작 파츠는 별도 검수가 필요합니다."}</p>}
    <details className="connection-options"><summary>ChatGPT 연결 준비 보기</summary>
      <p>현재 주소를 입구로 유지하며, 조건을 충족하는 오픈소스 앱의 본인 전용 서버 경로를 준비합니다. 다른 사용자에게 제공하는 원격 서비스의 참여 신청은 별도 경로입니다.</p>
      <p>실제 서버·사용자 로그인·이미지 처리는 확인 전입니다. 실행 시 기존 ChatGPT 사용량을 소비하며, 별도 API 과금은 꺼져 있습니다. 서버 운영비는 아직 확정되지 않았습니다.</p>
      <a className="button secondary small" href={import.meta.env.BASE_URL + "connection/"}>ChatGPT 연결 준비 열기</a>
    </details>
    {connection.csrf && <div className="ai-account-actions">
      {connection.plan?.mode!=="personal-vm"?<button className="button secondary small" disabled={busy} onClick={()=>void connect("login")}>Continue with ChatGPT</button>:<span>최초 ChatGPT 로그인·재연결은 준비된 PC 연결 도구에서 진행합니다.</span>}
      <button className="button secondary small" disabled={busy} onClick={()=>void refreshConnection()}>연결 상태 새로고침</button>
      <button className="button secondary small" disabled={busy||!connection.plan?.loginCompleted} onClick={()=>void connect("models")}>사용 가능한 모델 확인</button>
      {connection.plan?.account && <><span>{connection.plan.account.email} · 등록 {connection.plan.account.registration}</span><button className="button secondary small" disabled={busy} onClick={()=>void connect("logout")}>앱 로그아웃</button></>}
      {connection.plan?.mode==="personal-vm"&&<button className="button secondary small" disabled={busy} onClick={()=>void fetch("/api/owner/logout",{method:"POST"}).then(()=>location.assign("/owner/login"))}>작업실 잠그기</button>}
    </div>}
    <div className="ai-source-selection"><b>GPT에 전달할 같은 건물의 자료 · 최대 6개</b><p>선택한 사진·도면을 한 구조로 해석합니다. PDF는 미리 연 한 페이지를 사용합니다. 로컬 윤곽 추출은 아래에서 선택한 한 입면만 처리합니다.</p>
      {sources.map(s=><label key={s.id}><input type="checkbox" aria-label={"GPT 자료 선택: "+s.name} checked={aiSourceIds.includes(s.id)} disabled={busy||(!aiSourceIds.includes(s.id)&&aiSourceIds.length>=6)} onChange={e=>setAiSourceIds(ids=>e.target.checked?[...ids,s.id]:ids.filter(id=>id!==s.id))}/>{s.name}</label>)}
      {connection.plan?.models.length ? <label>계정에서 확인한 모델<select aria-label="GPT 모델 선택" value={model} onChange={e=>setModel(e.target.value)}>{connection.plan.models.map(m=><option value={m.slug} key={m.slug}>{m.display_name}</option>)}</select></label> : null}
      <label>전체 설계·수정 요청<textarea aria-label="GPT 설계 요청" value={aiInstruction} disabled={busy} onChange={e=>setAiInstruction(e.target.value)} placeholder="보존할 특징 또는 선택 요소 ID와 수정할 내용을 적어 주세요."/></label>
    </div>
    {scene && <p className="source-version-note">현재 모델의 근거: {[...new Set(scene.elements.flatMap(e=>e.evidence.map(v=>v.sourceId).filter(Boolean)))].map(id=>project.sources.find(s=>s.id===id)?.name||id).join(", ")||"자료 연결 기록 없음"}. {sources.some(s=>!scene.elements.some(e=>e.evidence.some(v=>v.sourceId===s.id)))?"새로 추가한 자료 중 모델에 아직 반영되지 않은 자료가 있습니다. 이전 모델을 보존 중입니다.":"자료가 추가되면 다시 해석하기 전까지 기존 모델을 유지합니다."}</p>}
    <div className="design-input-grid">
      <div className="design-reference">
        <div className="reference-tools"><button className="button secondary small" onClick={onAddSources} disabled={busy}>이미지·PDF 추가</button><span>원본을 고르고 PDF 페이지나 로컬 윤곽 영역을 확인하세요.</span></div>
        <label>분석할 자료<select aria-label="분석할 자료" value={sourceId} disabled={busy} onChange={e => setSourceId(e.target.value)}><option value="">사진·도면 자료를 선택하세요</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {pdf && <div className="pdf-controls"><label>PDF 페이지<input aria-label="PDF 분석 페이지" type="number" min="1" value={pageNumber} disabled={busy} onChange={e => setPageNumber(Number(e.target.value))}/></label><button className="button secondary small" disabled={busy} onClick={() => void openPdf()}>페이지 이미지 열기</button></div>}
        {preview ? <div className="reference-stage" onPointerDown={e => { if (!busy) { startPoint.current = cropPoint(e); e.currentTarget.setPointerCapture(e.pointerId); } }} onPointerUp={cropEnd}>
          <img ref={imageRef} src={preview} alt="분석 원본 이미지" draggable={false}/>
          <svg className="reference-overlay" viewBox={"0 0 " + (observation?.pixelWidth || 1000) + " " + (observation?.pixelHeight || 1000)} preserveAspectRatio="none">
            {observation && overlay && front && <><path d={projectionPath(front.outline)} className="projected-outline"/>{scene?.elements.filter(e => e.kind === "opening" && e.parentId === front.id).map(e => <path key={e.id} d={projectionPath(e.outline)} className={e.id === selectedId ? "selected-outline" : "projected-opening"}/>)}</>}
            {observation && element?.evidence.find(e => e.sourceId === sourceId && e.region)?.region && (() => { const r = element.evidence.find(e => e.sourceId === sourceId && e.region)!.region!; return <rect {...r} className="evidence-region"/>; })()}
            {crop && <rect x={crop.x * (observation?.pixelWidth || 1000)} y={crop.y * (observation?.pixelHeight || 1000)} width={crop.width * (observation?.pixelWidth || 1000)} height={crop.height * (observation?.pixelHeight || 1000)} className="crop-region"/>}
          </svg>
        </div> : <div className="reference-empty">‘자료 수집’에서 사진·도면 이미지 또는 PDF를 추가해 주세요. 원본이 없으면 샘플 집으로 바꾸어 완료 처리하지 않습니다.</div>}
        <div className="reference-tools"><span>이미지를 드래그하면 분석할 건물 영역을 지정합니다.</span><button onClick={() => setCrop(undefined)} disabled={busy}>영역 초기화</button><label><input type="checkbox" checked={overlay} onChange={e => setOverlay(e.target.checked)}/>입면 투영 겹쳐보기</label></div>
      </div>
      <div className="design-controls"><fieldset disabled={busy}>
        <label>크기 기준<select aria-label="크기 기준" value={sizeMode} onChange={e => setSizeMode(e.target.value as SizeSettings["mode"])}><option value="target-width">목표 완성 폭으로 만들기</option><option value="known-reference">알려진 실제 가로 기준거리 사용</option><option value="assumed-real">실물 크기 미확인·비례 모형</option></select></label>
        {sizeMode === "known-reference" ? <div className="control-pair"><label>실제 가로 기준거리 (mm)<input aria-label="실제 가로 기준거리" type="number" min="1" value={realWidth} onChange={e => setRealWidth(Number(e.target.value))}/></label><label>축척 분모<input aria-label="추정 설계 축척 분모" type="number" min="10" max="500" value={denominator} onChange={e => setDenominator(Number(e.target.value))}/></label></div> : <label>목표 모형 폭 (mm)<input aria-label="목표 모형 폭" type="number" min="30" max="2000" value={targetWidth} onChange={e => setTargetWidth(Number(e.target.value))}/></label>}
        <div className="control-pair"><label>자료 종류<select aria-label="이미지 투영 종류" value={projection} onChange={e => setProjection(e.target.value as EstimateOptions["projection"])}><option value="orthographic">정면·정투상 도면</option><option value="concept">시안·그림</option><option value="perspective">원근 사진·불확실성 높음</option></select></label><label>보완 범위<select aria-label="보완 범위" value={completion} onChange={e => setCompletion(e.target.value as EstimateOptions["completion"])}><option value="complete">보이는 면 유지·후면 창호 보완</option><option value="conservative">깊이·빈 후면만 보완</option><option value="visible-only">관찰 창호만 사용</option></select></label></div>
        <div className="control-pair"><label>깊이 / 폭 추정 비율<input aria-label="깊이 추정 비율" type="number" min="0.08" max="2" step="0.05" value={depthRatio} onChange={e => setDepthRatio(Number(e.target.value))}/></label><label>실제 판재 두께 (mm)<input aria-label="추정 설계 재료 두께" type="number" min="0.5" max="10" step="0.1" value={thickness} onChange={e => setThickness(Number(e.target.value))}/></label></div>
        <label>자동 검사·보완 최대 횟수<input aria-label="자동 보완 최대 횟수" type="number" min="1" max="3" value={iterations} onChange={e => setIterations(Number(e.target.value))}/></label>
      </fieldset><div className="design-run-actions"><button className="button primary" disabled={busy || !source || (pdf && !preview)} onClick={() => void run()}><Play size={16}/>이미지에서 외형 추정</button><button className="button secondary" disabled={!busy} onClick={() => controller.current?.abort()}><Square size={14}/>취소</button></div>
        <p className="local-engine-note">브라우저의 윤곽·대비 분석입니다. AI 의미 해석이나 건물 실측 복원은 미검증입니다. 실행 시간 15초, 외부 AI 요청 0회입니다.</p>
        <button className="button primary wide" disabled={busy||!connection.csrf||!connection.plan?.modelAccessVerified||!model||!aiSourceIds.length} title={connection.reason} onClick={()=>void runAi()}>ChatGPT로 설계하기</button>
        {connection.plan?.loginCompleted&&<p>연결한 ChatGPT 요금제·크레딧 사용량을 사용합니다. 기본 1회, 전체 최대 3회·90초입니다. 취소 전에 처리된 사용량의 환급은 보장하지 않습니다. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT 사용량 관리</a></p>}
        <div className="run-stage" aria-live="polite"><b>{busy ? "진행 중: " : ""}{stage}</b>{scene?.run && <span>수행 {scene.run.requestCount??scene.run.attempts.length}/{scene.run.maxIterations}회 · 실제 AI {scene.run.actualAiCompleted ? "완료" : "미실행"}</span>}</div>
      </div>
    </div>
    {error && <div className="design-error" role="alert"><AlertCircle size={17}/>{error}</div>}
    {scene && <div className="design-results">
      <div className="design-results-header"><div><b>건물 요소 {scene.elements.length}개</b><span>형상 버전 {scene.revision} · 사용자 원본 대조 필요</span></div><button className="button secondary small" disabled={!project.designHistory?.length || busy} onClick={onUndo}><Undo2 size={15}/>이전 형상으로</button></div>
      <div className="provenance-filters" role="group" aria-label="근거 분류 필터">{[["all","전체"],["observed","관찰"],["inferred","추정"],["designed","설계 보완"]].map(([v,n]) => <button key={v} className={proofFilter === v ? "active" : ""} onClick={() => setProofFilter(v)}>{n}</button>)}</div>
      <div className="element-workspace"><div className="element-list" aria-label="가변 건물 요소">{filtered.map(e => <button key={e.id} onClick={() => onSelect(e.id)} className={e.id === selectedId ? "selected" : ""}><span className={"provenance-dot " + e.provenance}/><span>{e.name}<small>{e.kind} · {PROVENANCE_LABELS[e.provenance]}</small></span>{e.locked && <LockKeyhole size={14}/>}</button>)}</div>
        <div className="element-inspector">{element ? <>
          <div className="inspector-heading"><b>{element.name}</b><button disabled={busy} aria-label={element.locked ? "요소 잠금 해제" : "요소 잠금"} onClick={() => change(() => editElement(scene, element.id, { locked: !element.locked }, "사용자 잠금 설정"), "요소 잠금 변경")}>{element.locked ? <LockKeyhole size={16}/> : <UnlockKeyhole size={16}/>}</button></div>
          <p>{PROVENANCE_LABELS[element.provenance]} · {element.userConfirmed ? "사용자 대조 기록 있음" : "사용자 미확인"} · 실측 {element.measured ? "기록 있음" : "미확인"}</p>
          {element.evidence.map((e,i) => <div className="evidence-note" key={i}><b>{PROVENANCE_LABELS[e.classification]} · 불확실성 {e.uncertainty}</b><p>{e.observation}</p><p>{e.reason}</p>{e.sourceId && <small>자료 {project.sources.find(s => s.id === e.sourceId)?.name || e.sourceId}{e.page ? " · PDF " + e.page + "쪽" : ""}{e.region ? " · 이미지 픽셀 영역 기록" : ""}</small>}</div>)}
          <fieldset disabled={element.locked || busy}><div className="control-pair"><label>가로 이동 (mm)<input aria-label="선택 요소 가로 이동" type="number" step="0.5" value={moveX} onChange={e => setMoveX(Number(e.target.value))}/></label><label>세로 이동 (mm)<input aria-label="선택 요소 세로 이동" type="number" step="0.5" value={moveY} onChange={e => setMoveY(Number(e.target.value))}/></label></div>
            <div className="control-pair"><label>요소 너비 (mm)<input aria-label="선택 요소 너비" type="number" step="0.1" value={Number(newWidth.toFixed(3))} onChange={e => setNewWidth(Number(e.target.value))}/></label><label>요소 높이 (mm)<input aria-label="선택 요소 높이" type="number" step="0.1" value={Number(newHeight.toFixed(3))} onChange={e => setNewHeight(Number(e.target.value))}/></label></div>
            <button className="button secondary small" onClick={() => change(() => editElement(scene, element.id, { dx: moveX, dy: moveY, width: newWidth, height: newHeight }, "사용자 수치 편집"), "선택 요소 수정")}>선택 요소 수정 적용</button>
            <label>선택 요소 수정 요청<input aria-label="선택 요소 수정 요청" placeholder="오른쪽으로 2mm 이동" value={instruction} onChange={e => setInstruction(e.target.value)}/></label><button className="button secondary small" onClick={() => change(() => applyInstruction(scene, element.id, instruction), "선택 요소 요청 적용")}>수정 요청 적용</button>
          </fieldset><small>방향·mm 이동과 높이 조절을 해석하는 로컬 규칙입니다. 해석하지 못한 요청은 임의 적용하지 않습니다.</small>
        </> : <p>목록이나 3D 모델에서 요소를 선택하면 근거와 편집 항목이 표시됩니다.</p>}</div></div>
      <details className="design-limitations"><summary>검사 결과와 보완 가정 · 오류 {issues.filter(i => i.severity === "error").length}개</summary>{issues.map((i,n) => <p key={n}>{i.message}</p>)}{scene.limitations.map((l,i) => <p key={i}>{l}</p>)}{comparison && <p>현재 입면 윤곽 겹침: {(comparison.silhouetteIoU * 100).toFixed(1)}% · 원본 영역 대비 개구부 중심 오차: {comparison.openingMeanErrorMm === undefined ? "미계산" : comparison.openingMeanErrorMm.toFixed(2) + " mm"} — 추출 윤곽·영역과 투영의 내부 비교입니다. 독립적인 원본 정확도 점수가 아닙니다. 후면·측면·지붕 교차선 미검증.</p>}</details>
    </div>}
  </section>;
}
