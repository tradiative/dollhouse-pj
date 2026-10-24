import {test} from "node:test";
import assert from "node:assert/strict";
import polygonClipping from "polygon-clipping";
import {compileProgram} from "../src/design/program";
import {DEFAULT_FABRICATION} from "../src/design/types";
import {area,clippingPolygon,modelBounds,validateDesign,worldPoint} from "../src/design/geometry";
import {compileDesign} from "../src/design/compile";
import {parseBuildingDesign} from "../src/design/parse";
import {editElement} from "../src/design/editing";
import {partsCsv,manufacturingPackage} from "../src/design/deliverables";
import {emptyProject,projectParts} from "../src/engine";
import {unzipSync,strFromU8} from "fflate";
import {programFixture} from "./helpers/programFixture";
const size={mode:"target-width" as const,targetWidthMm:300};
const make=()=>compileProgram(programFixture(),size,DEFAULT_FABRICATION);
test("new projects contain no example sources or template geometry",()=>{const p=emptyProject();assert.equal(projectParts(p).length,0);assert.equal(p.sources.length,0);assert.equal(p.name,"새 건축 모형");});
test("multiple masses have distinct axes, outside walls, openings, and clipped roof valleys",()=>{
 const s=make();assert.equal(validateDesign(s).filter(i=>i.severity==="error").length,0);assert.equal(s.masses!.length,2);assert.notEqual(s.masses![0].roofAxis,s.masses![1].roofAxis);assert.equal(s.elements.filter(e=>e.kind==="opening").length,3);
 const mainFront=s.elements.find(e=>e.massId==="main"&&e.face==="front"&&e.kind==="wall")!;
 // The entrance's overlap removes the hidden middle of the front wall.
 assert.ok(area(mainFront.outline)<100*30*9);
 const roofs=s.elements.filter(e=>e.kind==="roof");let projected=0;
 const domains=roofs.map(e=>e.outline.map(p=>{const q=worldPoint(e,p);return [Math.round(q[0]*1e8)/1e8,Math.round(q[2]*1e8)/1e8] as [number,number];}));
 for(let i=0;i<domains.length;i++){projected+=area(domains[i]);for(let j=i+1;j<domains.length;j++){const overlap=polygonClipping.intersection(clippingPolygon(domains[i]),clippingPolygon(domains[j]));assert.ok(overlap.reduce((n,p)=>n+area(p[0] as [number,number][]),0)<1e-5,"roof faces must not overlap in plan");}}
 // Main 100x40 plus the exposed 30x15 entrance, scaled 3x in both axes.
 assert.ok(Math.abs(projected-4450*9)<1e-5);assert.ok(Math.abs(modelBounds(s).width-300)<2);
 assert.ok(compileDesign(s).length>s.elements.filter(e=>e.kind!=="opening").length);
});
test("a roof-only cross gable does not erase the main building walls",()=>{
 const p=programFixture();p.masses[1].roofOnly=true;p.openings=p.openings.filter(o=>o.massId!=="entrance");
 const s=compileProgram(p,size,DEFAULT_FABRICATION);assert.ok(s.elements.filter(e=>e.massId==="main"&&e.kind==="wall").every(e=>area(e.outline)>0));assert.equal(s.masses![1].roofOnly,true);assert.ok(s.elements.some(e=>e.massId==="entrance"&&e.kind==="roof"));
});
test("multi-source program, protected element edit and original-inclusive metadata roundtrip",()=>{
 const s=make();const locked=editElement(s,"win-back",{locked:true},"test");const changed=editElement(locked,"win-left",{dx:2},"move");assert.deepEqual(changed.elements.find(e=>e.id==="win-back"),locked.elements.find(e=>e.id==="win-back"));assert.equal(parseBuildingDesign(JSON.parse(JSON.stringify(changed))).masses!.length,2);assert.throws(()=>editElement(changed,"win-back",{dx:1},"blocked"),/잠긴/);
});
test("a program cannot put an opening on a hidden internal wall or introduce invalid masses",()=>{
 const p=programFixture();p.openings[0].x=60;assert.throws(()=>compileProgram(p,size,DEFAULT_FABRICATION),/외벽/);p.openings=[];p.masses[0].width=NaN;assert.throws(()=>compileProgram(p,size,DEFAULT_FABRICATION),/수치/);
});
test("manufacturing ZIP contains real per-part STLs, shared version, BOM and unit instructions",()=>{
 const s=make(),p={...emptyProject("시험 구조"),design:s};const parts=projectParts(p),entries=unzipSync(manufacturingPackage(p));
 assert.equal(Object.keys(entries).filter(n=>n.startsWith("parts/")).length,parts.length);assert.ok(strFromU8(entries["README.txt"]).includes("mm"));assert.equal(strFromU8(entries["part-list.csv"]).trim().split(/\r?\n/).length,parts.length+1);assert.equal(JSON.parse(strFromU8(entries["project.json"])).parts.length,parts.length);
 assert.match(partsCsv([{...parts[0],name:"=SUM(A1:A3)"}],1),/'=SUM/);for(const name of Object.keys(entries).filter(n=>n.endsWith(".stl")))assert.match(strFromU8(entries[name]),/facet normal/);
});
test("the attributed Impi review case has valid joined geometry and distinct front/back/side source evidence",async()=>{
 const {readFile}=await import("node:fs/promises");const input=JSON.parse(await readFile("docs/cases/impi-program-v3.json","utf8"));const scene=compileProgram(input,size,DEFAULT_FABRICATION);assert.equal(scene.masses!.length,6);assert.equal(validateDesign(scene).filter(i=>i.severity==="error").length,0);assert.equal(scene.run,undefined);assert.ok(new Set(scene.elements.flatMap(e=>e.evidence.map(p=>p.sourceId))).has("sides"));assert.equal(scene.elements.filter(e=>e.kind==="opening"&&e.massId==="main"&&e.face==="front").length,8);assert.equal(scene.elements.filter(e=>e.kind==="opening"&&e.massId==="main"&&e.face==="left").length,3);assert.ok(scene.limitations.some(l=>l.includes("GPT API 자동생성 결과가 아닙니다")));assert.ok(compileDesign(scene).length>40);
});
