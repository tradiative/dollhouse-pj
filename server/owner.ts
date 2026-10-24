import type { Express, Request } from "express";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { privateRead } from "./privateFiles";
const scrypt=promisify(scryptCallback);
export type OwnerRecord={version:1;salt:string;hash:string;subject:string;clientId:string};
export async function ownerPassword(password:string,subject:string,clientId:string):Promise<OwnerRecord> {
  if(password.length<14||password.length>200)throw new Error("작업실 비밀번호를 14~200자로 정하세요.");
  const salt=randomBytes(32).toString("hex"),hash=(await scrypt(password,salt,64) as Buffer).toString("hex");
  return {version:1,salt,hash,subject,clientId};
}
export function vmSettings(env:NodeJS.ProcessEnv=process.env) {
  if(env.TRADIATIVE_CHATGPT_MODE!=="personal-vm")return undefined;
  const origin=new URL(env.TRADIATIVE_PUBLIC_ORIGIN||"https://invalid.invalid");
  if(env.TRADIATIVE_OSS_REVIEWED!=="true"||origin.protocol!=="https:"||origin.origin!==env.TRADIATIVE_PUBLIC_ORIGIN||origin.hostname.endsWith(".invalid")||origin.username||origin.password||!env.TRADIATIVE_AUTH_DIR||!env.TRADIATIVE_AUTH_DIR.startsWith("/")||env.TRADIATIVE_ALLOW_SEPARATE_API==="true")throw new Error("개인 VM은 OSS 적용 검토·실제 HTTPS 주소·보호된 저장 위치가 필요하며 별도 API를 켤 수 없습니다.");
  return {origin:origin.origin,directory:env.TRADIATIVE_AUTH_DIR};
}
export function registerOwnerGate(app:Express,config:{origin:string;directory:string}, now=()=>Date.now()) {
  const sessions=new Map<string,{expires:number}>(); let failed:number[]=[];
  const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
  const cookie=(req:Request)=>req.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith("tradiative_owner="))?.slice(17)||"";
  const checked=(req:Request)=>{const s=sessions.get(digest(cookie(req)));if(!s||s.expires<now())return false;return true;};
  const origin=(req:Request)=>{
    // No trust in forwarded host/origin and no CORS. TLS terminates at the configured reverse proxy.
    if(req.get("host")!==new URL(config.origin).host)throw new Error("작업실 주소가 일치하지 않습니다.");
    if(!["GET","HEAD"].includes(req.method)&&req.get("origin")!==config.origin)throw new Error("이 작업실에서 시작한 요청이 아닙니다.");
    return config.origin;
  };
  app.use((req,res,next)=>{
    try{origin(req);}catch{res.status(403).json({error:"허용된 작업실 주소에서만 접근할 수 있습니다."});return;}
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
    if(req.path==="/api/health"&&req.method==="GET"){next();return;}
    if(req.path==="/owner/login") {next();return;}
    if(!checked(req)){if(req.path.startsWith("/api/")||req.method!=="GET")res.status(401).json({state:"owner-login-required",error:"본인 전용 작업실에 먼저 로그인하세요."});else res.redirect(303,"/owner/login");return;}
    next();
  });
  app.get("/owner/login",(_req,res)=>{res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");res.type("html").send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRADIATIVE 개인 작업실</title><style>body{font:16px/1.8 system-ui;background:#f6f6ef;color:#293c31;max-width:480px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:10px 0}button{background:#304f3b;color:white;border:0;border-radius:6px}</style><h1>본인 전용 작업실</h1><p>PC 연결 도구에서 정한 작업실 비밀번호로 로그인하세요.</p><form method="post" action="/owner/login"><label>작업실 비밀번호<input name="password" type="password" autocomplete="current-password" required minlength="14" maxlength="200"></label><button>작업실 열기</button></form><p>이 로그인은 작업실 접근용입니다. ChatGPT 사용량 연결과 이미지 처리 여부는 안에서 따로 확인합니다.</p></html>`);});
  app.post("/owner/login",async(req,res)=>{
    failed=failed.filter(t=>now()-t<15*60_000);
    if(failed.length>=6){res.status(429).send("로그인 시도 한도입니다. 15분 뒤 다시 시도하세요.");return;}
    failed.push(now()); // Reserve the attempt before async scrypt; parallel failures share the same cap.
    const password=req.body?.password;
    if(typeof password!=="string"||password.length<14||password.length>200){res.status(403).send("작업실 비밀번호를 확인하세요.");return;}
    try{
      const record=await privateRead(config.directory,"owner.json") as OwnerRecord;
      if(record.version!==1||!/^[a-f0-9]{64}$/.test(record.salt)||!/^[a-f0-9]{128}$/.test(record.hash))throw new Error("owner record");
      const hash=await scrypt(password,record.salt,64) as Buffer;
      if(!timingSafeEqual(hash,Buffer.from(record.hash,"hex"))){res.status(403).send("작업실 비밀번호를 확인하세요.");return;}
      const token=randomBytes(32).toString("base64url");sessions.clear();sessions.set(digest(token),{expires:now()+8*3600_000});failed=[];
      res.setHeader("Set-Cookie",`tradiative_owner=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);res.redirect(303,"/");
    }catch{res.status(503).send("본인 전용 연결 도구를 통한 서버 준비가 아직 완료되지 않았습니다.");}
  });
  app.post("/api/owner/logout",(req,res)=>{sessions.delete(digest(cookie(req)));res.setHeader("Set-Cookie","tradiative_owner=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");res.json({ok:true});});
  return {mode:"personal-vm" as const,origin:(req:Request)=>{origin(req);if(!checked(req))throw new Error("작업실 로그인 필요");return config.origin;}};
}
