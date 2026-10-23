import { zip, unzipSync, strToU8, strFromU8 } from "fflate";
import { manifest, sampleProject, validDimensions, type Project, type Source } from "../engine";
import { imageData, readSourceFile, saveSourceFile } from "../sourceStore";
import { parseBuildingDesign } from "./parse";
const MAX_BYTES = 60 * 1024 * 1024;
export function parseProjectMetadata(input: unknown): Project {
  if (!input || typeof input !== "object") throw new Error("프로젝트 형식이 잘못되었습니다.");
  const p = input as Project & { schema?: string };
  if (!["tradiative.project.v1", "tradiative.project.v2"].includes(p.schema || "") || typeof p.name !== "string" || !validDimensions(p.dimensions) || !Array.isArray(p.sources) || p.sources.length > 100) throw new Error("지원되는 프로젝트 JSON이 아닙니다.");
  const sources: Source[] = p.sources.map(s => {
    if (!s || typeof s.name !== "string" || typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(s.id) || typeof s.size !== "number" || !Number.isFinite(s.size) || s.size < 0 || s.size > 10 * 1024 * 1024) throw new Error("원본 자료 메타데이터가 잘못되었습니다.");
    return { id: s.id, name: s.name.slice(0, 200), type: typeof s.type === "string" ? s.type.slice(0, 100) : "", size: s.size, sample: s.sample === true, text: typeof s.text === "string" && !s.text.startsWith("data:") ? s.text.slice(0, 150000) : undefined };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error("자료 ID가 중복됩니다.");
  const design = p.design ? parseBuildingDesign(p.design, false, true) : undefined;
  const designHistory = Array.isArray(p.designHistory) ? p.designHistory.slice(-10).map(h => ({ at: String(h.at).slice(0, 50), label: String(h.label).slice(0, 200), design: parseBuildingDesign(h.design, false, true) })) : [];
  return { ...sampleProject(), name: p.name.slice(0, 100), dimensions: p.dimensions, sources, design, designHistory, physicalNote: typeof p.physicalNote === "string" ? p.physicalNote.slice(0, 10000) : "", confirmed: false, physicalConfirmed: false, generatedSignature: "", updatedAt: new Date().toISOString() };
}
async function digest(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(n => n.toString(16).padStart(2, "0")).join("");
}
export async function packageProject(project: Project) {
  const entries: Record<string, Uint8Array> = {};
  const files: Array<{ id: string; path: string; sha256: string; bytes: number }> = [];
  let total = 0;
  for (const s of project.sources.filter(s => !s.sample)) {
    const blob = await readSourceFile(s.id);
    if (!blob) throw new Error(s.name + " 원본이 없어 전체 백업을 만들지 않았습니다. 원본을 다시 첨부하거나 메타데이터 JSON으로 보관하세요.");
    total += blob.size;
    if (blob.size > 10 * 1024 * 1024 || total > MAX_BYTES) throw new Error("원본 포함 백업은 파일당 10 MB, 합계 60 MB까지 지원합니다.");
    const data = new Uint8Array(await blob.arrayBuffer()), path = "references/" + s.id;
    entries[path] = data; files.push({ id: s.id, path, sha256: await digest(data), bytes: data.length });
  }
  entries["project.json"] = strToU8(JSON.stringify({ ...manifest(project), sourceFiles: files }));
  if (entries["project.json"].length > 8 * 1024 * 1024 || total + entries["project.json"].length > MAX_BYTES) throw new Error("형상·이력 포함 백업 용량을 초과했습니다. 메타데이터는 8 MB, 원본 포함 합계는 60 MB까지 지원합니다.");
  return new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 4 }, (error, data) => error ? reject(error) : resolve(data)));
}
export async function restorePackage(data: Uint8Array): Promise<Project> {
  if (data.byteLength > MAX_BYTES) throw new Error("백업 ZIP은 60 MB 이하만 가져올 수 있습니다.");
  let total = 0, filtered = false;
  const entries = unzipSync(data, { filter: file => {
    total += file.originalSize;
    const allowed = (file.name === "project.json" || /^references\/[A-Za-z0-9_-]{1,100}$/.test(file.name)) && file.originalSize <= (file.name === "project.json" ? 8 : 10) * 1024 * 1024 && total <= MAX_BYTES;
    if (!allowed) filtered = true;
    return allowed;
  } });
  if (filtered || Object.keys(entries).length > 101 || !entries["project.json"] || entries["project.json"].length > 8 * 1024 * 1024) throw new Error("백업 경로 또는 압축 해제 크기 제한을 위반했습니다.");
  const raw = JSON.parse(strFromU8(entries["project.json"])), p = parseProjectMetadata(raw);
  if (!Array.isArray(raw.sourceFiles) || raw.sourceFiles.length !== p.sources.filter(s => !s.sample).length) throw new Error("원본 자료 목록이 맞지 않습니다.");
  const prepared: Array<{ oldId: string; newId: string; blob: Blob }> = [];
  for (const s of p.sources.filter(s => !s.sample)) {
    const f = raw.sourceFiles.find((f: { id: string }) => f.id === s.id);
    if (!f || f.path !== "references/" + s.id || !entries[f.path] || entries[f.path].length !== f.bytes || entries[f.path].length !== s.size || await digest(entries[f.path]) !== f.sha256) throw new Error(s.name + " 원본의 무결성 확인에 실패했습니다.");
    prepared.push({ oldId: s.id, newId: crypto.randomUUID(), blob: new Blob([new Uint8Array(entries[f.path])], { type: s.type }) });
  }
  // Use fresh IDs so a backup import never overwrites existing source originals.
  const ids = new Map(prepared.map(f => [f.oldId, f.newId]));
  for (const file of prepared) await saveSourceFile(file.newId, file.blob);
  p.sources = await Promise.all(p.sources.map(async s => {
    const file = prepared.find(f => f.oldId === s.id);
    return file ? { ...s, id: file.newId, url: undefined, text: /^image\/(png|jpeg|webp)$/.test(s.type) ? await imageData(file.blob) : s.text } : s;
  }));
  for (const scene of [p.design, ...p.designHistory!.map(h => h.design)].filter(s => s !== undefined)) {
    for (const o of scene.observations) o.sourceId = ids.get(o.sourceId) || o.sourceId;
    for (const proof of [...scene.assumptions, ...scene.elements.flatMap(e => e.evidence)]) if (proof.sourceId) proof.sourceId = ids.get(proof.sourceId) || proof.sourceId;
  }
  return p;
}
export function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
