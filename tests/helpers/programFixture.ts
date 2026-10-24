import type { BuildingProgram } from "../../src/design/program";
import type { Evidence } from "../../src/design/types";
export const proof = (sourceId="front",classification:Evidence["classification"]="observed"):Evidence=>({classification,sourceId,observation:"명시적인 시험 도면 근거",reason:"실제 건축물 아님 · 엔진 검사 입력",uncertainty:"medium",alternatives:[],links:[]});
export function programFixture():BuildingProgram{return {schema:"tradiative.program.v1",units:"relative",masses:[
{id:"main",name:"시험 본체",x:0,z:0,width:100,depth:40,eave:30,roof:{type:"gable",axis:"x",rise:15,overhang:0},evidence:[proof()]},
{id:"entrance",name:"시험 돌출부",x:55,z:20,width:30,depth:35,eave:30,roof:{type:"gable",axis:"z",rise:15,overhang:0},evidence:[proof("side")]}
],openings:[
{id:"win-left",name:"시험 왼쪽 창",massId:"main",face:"front",x:10,y:10,width:8,height:15,role:"window",evidence:[proof()]},
{id:"win-back",name:"시험 후면 창",massId:"main",face:"back",x:30,y:10,width:12,height:15,role:"window",evidence:[proof("side")]},
{id:"entry",name:"시험 입구",massId:"entrance",face:"front",x:10,y:0,width:10,height:24,role:"door",evidence:[proof("side")]}
],observations:[],assumptions:[proof("front","inferred")],limitations:["자동 검사 전용 합성 구조"]};}
