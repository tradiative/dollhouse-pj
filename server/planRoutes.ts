import type { Express, Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { ChatGPTSession, PlanError, authDirectory, personalPlanEnabled, type Http } from "./chatgpt";
import { planHttp } from "./planTransport";
import { readCompletedDesign } from "./ai";
import { PROGRAM_CONTRACT } from "../src/design/program";
import { parseBuildingDesign } from "../src/design/parse";
import { mergeLockedDesign, protectedIds } from "../src/design/editing";
import { validateDesign } from "../src/design/geometry";
import type { EstimateOptions } from "../src/design/types";

const http: Http = planHttp;
const ownerAddress = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
export function localOrigin(req: Request) {
  if (!ownerAddress(req) || !/^127\.0\.0\.1:\d+$/.test(req.get("host") || "")) throw new PlanError("unsupported", "개인 실행은 해당 PC의 127.0.0.1 주소에서만 사용할 수 있습니다. 공개 원격 연결은 활성화하지 않았습니다.");
  return "http://" + req.get("host");
}
function fail(res: Response, error: unknown) {
  const p = error instanceof PlanError ? error : new PlanError("failed", error instanceof Error ? error.message.slice(0,800) : "요청을 완료하지 못했습니다.");
  res.status(p.state === "limited" ? 429 : p.state === "cancelled" ? 499 : p.state === "denied" ? 403 : p.state === "unsupported" ? 503 : 400).json({state:p.state,error:p.message});
}
export function registerPlanRoutes(app: Express, supplied?: ChatGPTSession, enabled = personalPlanEnabled(), policy?:{mode:"personal-vm";origin:(req:Request)=>string}) {
  const session = supplied || new ChatGPTSession(authDirectory(), http);
  let running = false;
  let requests: number[] = [];
  const safe = (fn: (req: Request,res: Response,next: NextFunction) => Promise<void>) => async (req: Request,res: Response,next: NextFunction) => { try { await fn(req,res,next); } catch(e) { if(!res.destroyed)fail(res,e); } };
  const checkedOrigin = (req:Request) => policy ? policy.origin(req) : localOrigin(req);
  const mutation = (req: Request) => { const origin=checkedOrigin(req); if(req.get("origin")!==origin || req.get("x-tradiative-csrf")!==session.csrf)throw new PlanError("denied","이 화면에서 시작한 요청이 아닙니다. 화면을 새로 열어 주세요."); return origin; };
  app.get("/api/ai/status",safe(async(req,res,next)=>{
    if(!enabled){next();return;}checkedOrigin(req);const s=await session.initialize();
    res.setHeader("Cache-Control","no-store");
    res.json({state:s.actualRequestVerified?"image-verified":s.modelAccessVerified?"model-access":s.loginCompleted?"authenticated":"disconnected",label:s.actualRequestVerified?"실제 이미지 처리 확인"+(s.geometryVerified?" · 형상 검사 통과":" · 형상 검사 실패"):s.loginCompleted?"ChatGPT 로그인 완료 · 실제 이미지 처리 미검증":"ChatGPT 로그인 필요",
      reason:s.actualRequestVerified?"연결한 ChatGPT 요금제의 사용량을 사용합니다. 자료 재현 품질·제작 파츠 검수는 별도로 필요합니다.":"ChatGPT 사용량 연결 준비 중입니다. 별도 API 과금은 꺼져 있습니다. "+(policy?"본인 전용 VM입니다. 최초 공식 로그인·동의는 준비된 PC 연결 도구에서 수행합니다.":"이 PC에서 공식 로그인과 사용량 동의를 진행합니다."),provider:"chatgpt-plan",actualRequestVerified:s.actualRequestVerified,remainingUsage:null,csrf:session.csrf,plan:{...s,mode:policy?.mode||"personal-local"},capabilities:{images:s.actualRequestVerified?"verified":"unverified",structuredOutput:s.geometryVerified?"runtime-validated":"unverified",search:"not-connected"},separateApi:{enabled:false}});
  }));
  app.post("/api/ai/login",safe(async(req,res,next)=>{if(!enabled){next();return;}const origin=mutation(req);if(policy)throw new PlanError("unsupported","자가 서버의 최초 공식 로그인은 PC 연결 도구에서 진행합니다. 서버의 loopback 주소를 사용자 PC로 안내하지 않습니다.");res.setHeader("Cache-Control","no-store");res.json({url:await session.begin(origin)});}));
  app.get("/auth/callback",safe(async(req,res)=>{
    if(!enabled)throw new PlanError("unsupported","이 실행부의 개인 로그인을 활성화하지 않았습니다.");
    if(policy)throw new PlanError("unsupported","이 VM은 원격 OAuth callback을 수신하지 않습니다.");
    localOrigin(req);await session.callback(new URL(req.originalUrl,"http://127.0.0.1").searchParams);
    res.setHeader("Cache-Control","no-store");res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'");
    res.type("html").send('<!doctype html><html lang="ko"><meta charset="UTF-8"><title>TRADIATIVE 로그인</title><style>body{font:18px sans-serif;margin:4em;line-height:1.8}a{color:#253c32}</style><h1>ChatGPT 로그인 완료</h1><p>모델 권한과 실제 이미지 요청은 아직 확인 전입니다.</p><a href="/">작업실로 돌아가기</a></html>');
  }));
  app.post("/api/ai/models",safe(async(req,res)=>{if(!enabled)throw new PlanError("unsupported","현재 원격 앱은 구독 실행부가 연결되지 않았습니다.");mutation(req);res.json({models:await session.listModels()});}));
  app.post("/api/ai/logout",safe(async(req,res)=>{if(!enabled)throw new PlanError("unsupported","연결된 앱 로그인 없음");mutation(req);if(running)throw new PlanError("failed","진행 중인 작업을 취소한 뒤 로그아웃하세요.");res.json(await session.logout());}));
  app.post("/api/design",safe(async(req,res,next)=>{
    if(req.body?.provider!=="chatgpt-plan" || !enabled){next();return;}mutation(req);
    requests=requests.filter(t=>Date.now()-t<60000);
    if(running || requests.length>=6)throw new PlanError("limited","이 개인 실행부의 동시 실행 또는 분당 요청 한도에 도달했습니다.");
    const sources=req.body.sources as Array<{id:string;name:string;image:string;page?:number}>;
    const options=req.body.options as EstimateOptions;
    if(!Array.isArray(sources)||sources.length<1||sources.length>6||new Set(sources.map(s=>s?.id)).size!==sources.length||!options?.size||!options.fabrication||!Number.isFinite(options.size.targetWidthMm)||options.size.targetWidthMm<30||options.size.targetWidthMm>2000||sources.some(s=>!s||typeof s.id!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(s.id)||typeof s.name!=="string"||s.name.length>200||typeof s.image!=="string"||s.image.length>3_000_000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(s.image)))throw new PlanError("failed","지원 이미지 최대 6개와 목표 크기·제작 설정을 확인하세요.");
    if(!Number.isInteger(options.maxIterations)||options.maxIterations<1||options.maxIterations>3)throw new PlanError("failed","AI 요청은 최대 3회까지 허용됩니다.");
    const previous=req.body.previous?parseBuildingDesign(req.body.previous):undefined;
    if(previous&&protectedIds(previous).size&&(JSON.stringify(previous.size)!==JSON.stringify(options.size)||JSON.stringify(previous.fabrication)!==JSON.stringify(options.fabrication)))throw new PlanError("failed","잠긴 요소가 있어 전체 크기·재료를 바꾸지 않았습니다.");
    const instruction=typeof req.body.instruction==="string"?req.body.instruction.slice(0,2000):"";
    const model=typeof req.body.model==="string"?req.body.model:"";
    const abort=new AbortController(),started=Date.now(),signal=AbortSignal.any([abort.signal,AbortSignal.timeout(90000)]);
    const close=()=>{if(!res.writableEnded)abort.abort();};res.on("close",close);running=true;
    let count=0,lastError="",result:Record<string,unknown>|undefined;
    const fingerprints=sources.map(s=>({id:s.id,name:s.name,page:s.page,sha256:createHash("sha256").update(Buffer.from(s.image.split(",")[1],"base64")).digest("hex")}));
    const input:Array<unknown>=[{role:"user",content:sources.flatMap(s=>[{type:"input_text",text:JSON.stringify({sourceId:s.id,name:s.name,page:s.page})},{type:"input_image",image_url:s.image,detail:"high"}])}];
    const instructions=PROGRAM_CONTRACT+"\nTarget size and fabrication: "+JSON.stringify(options)+"\nUser request: "+instruction+(previous?"\nExisting geometry, stable element IDs and locks (do not erase confirmed elements): "+JSON.stringify(previous):"");
    try{
      for(let i=0;i<options.maxIterations;i++){
        if(signal.aborted)throw new PlanError(abort.signal.aborted?"cancelled":"limited","AI 실행이 취소되었거나 90초 한도에 도달했습니다.");
        requests.push(Date.now());count++;
        result=await session.infer(model,input,instructions,signal);
        session.lastCompleted={model,responseId:String(result.id||""),at:new Date().toISOString(),sourceIds:sources.map(s=>s.id),sourceHashes:fingerprints.map(s=>s.sha256),usage:result.usage,validDesign:false,requestCount:count,elapsedMs:Date.now()-started};
        try{
          let scene=readCompletedDesign(result,options,new Set(sources.map(s=>s.id)));
          if(previous)scene=mergeLockedDesign(previous,scene);
          const issues=validateDesign(scene).filter(i=>i.severity==="error");if(issues.length)throw new Error(issues.slice(0,4).map(i=>i.message).join(" "));
          scene.run={id:"plan-"+started,engine:"chatgpt-plan",state:"completed-with-review",model,responseId:typeof result.id==="string"?result.id:undefined,inputSources:fingerprints,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),attempts:[],requestCount:count,maxRequests:options.maxIterations,maxIterations:options.maxIterations,elapsedMs:Date.now()-started,actualAiCompleted:true,search:"not-used",warnings:[...scene.limitations,"원본 특징의 독립적인 시각 검수·실물 제작은 미검증입니다. 자동 재요청은 구조·수치 오류 수정에 한정합니다."]};
          session.lastCompleted={...session.lastCompleted,validDesign:true,elapsedMs:Date.now()-started};
          if(!res.destroyed)res.json({state:"completed-with-review",scene});return;
        }catch(e){lastError=e instanceof Error?e.message:"구조 검사 실패";if(i+1<options.maxIterations)input.push({role:"assistant",content:JSON.stringify(result.output).slice(0,400000)},{role:"user",content:"The previous JSON failed validation: "+lastError+". Return a corrected full program JSON, preserving source features and locked elements. No code."});}
      }
      throw new PlanError("failed","GPT 응답은 완료됐으나 형상 검사를 통과하지 못했습니다. 기존 모델을 보존합니다. "+lastError);
    }finally{running=false;res.off("close",close);}
  }));
  return session;
}
