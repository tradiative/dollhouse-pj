import { zipSync, strToU8 } from "fflate";
import { manifest, projectParts, svgDrawing, dxfDrawing, stlAssembly, stlPart, type Project, type Part } from "../engine";
import { bounds } from "./geometry";
const cell = (value: string|number) => {
  let s=String(value);if(typeof value==="string"&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';
};
export function partsCsv(parts: Part[], revision: number|string) {
  return "\ufeff"+[["part_id","name","source_element_id","material","thickness_mm","width_mm","height_mm","quantity","process","geometry_revision"],...parts.map(p=>{const b=bounds(p.outline);return [p.id,p.name,p.sourceElementId||p.id,p.material,p.thickness,Number(b.width.toFixed(3)),Number(b.height.toFixed(3)),1,"flat-panel-review",revision];})].map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n";
}
export function manufacturingPackage(project: Project) {
  const parts=projectParts(project);if(!parts.length)throw new Error("내보낼 파츠가 없습니다.");
  const entries:Record<string,Uint8Array>={};const put=(name:string,text:string)=>{entries[name]=strToU8(text);};
  put("README.txt",["TRADIATIVE 제작 검토용 파츠","모든 길이는 mm입니다. STL 자체에는 단위가 없으므로 가져올 때 mm를 선택하세요.","assembly-mm.stl: 오른손 좌표계 Z-up, 바닥 Z=0. parts/*.stl: 부품 로컬 XY, 두께 +Z.","drawing.svg/dxf: 개별 평면 판재 전개 도안. 임의 입체 모델의 화면 캡처가 아닙니다.","part-list.csv의 각 행 수량은 1. 재료 두께는 실물 구매 두께이며 축척으로 나누지 않습니다.","kerf 보정·끼움 조인트·구조 강도·판재 두께의 지붕 접합·실물 조립은 미검증입니다.","현재 clearance는 창틀 외곽 여유에만 적용됩니다. 접착/끼움 전체 보정 완료가 아닙니다.","원본 파일은 이 제작 꾸러미에 포함되지 않습니다. 작업실의 원본 포함 백업을 따로 보관하세요.","프로젝트: "+project.name,"형상 버전: "+(project.design?.revision||"legacy"),"상태: 검토용 · 양산 승인 아님"].join("\r\n"));
  put("drawing.svg",svgDrawing(parts,project.dimensions,project.design?.size,project.design?.fabrication));put("drawing.dxf",dxfDrawing(parts));put("assembly-mm.stl",stlAssembly(parts));put("part-list.csv",partsCsv(parts,project.design?.revision||"legacy"));put("project.json",JSON.stringify(manifest(project),null,2));
  for(const p of parts)put("parts/"+p.id+".stl",stlPart(p));
  return zipSync(entries,{level:4});
}
