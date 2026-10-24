import express from "express";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ChatGPTSession } from "./chatgpt";
import { ownerPassword } from "./owner";
import { planHttp } from "./planTransport";
import { lockAuthDirectory, privateRead, privateWrite } from "./privateFiles";
import type { VmHandoff } from "./vmImport";
type Target={version:1;ossReviewed:true;origin:string;sshHost:string;sshUser:string;identityFile:string;knownHostsFile:string;remoteImporter:string;remoteStateDirectory:string};
const escape=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
export function validateTarget(value:unknown):Target {
  const c=value as Target,u=new URL(c?.origin);
  if(c.version!==1||c.ossReviewed!==true||u.protocol!=="https:"||u.origin!==c.origin||u.username||u.password||u.hostname.endsWith(".invalid")||!/^([a-z0-9][a-z0-9.-]{0,252})$/i.test(c.sshHost)||!(/^[a-z_][a-z0-9_-]{0,31}$/i.test(c.sshUser))||![c.identityFile,c.knownHostsFile].every(f=>typeof f==="string"&&path.isAbsolute(f))||path.basename(c.identityFile)!=="tradiative_vm_ed25519"||path.basename(c.knownHostsFile)!=="known_hosts"||path.dirname(c.identityFile)!==path.dirname(c.knownHostsFile)||![c.remoteImporter,c.remoteStateDirectory].every(p=>typeof p==="string"&&/^\/[a-zA-Z0-9_/.\-]+$/.test(p)&&!p.includes("..")))throw new Error("검토·배포된 본인 전용 서버 설정이 필요합니다.");
  return c;
}
export async function sendSsh(target:Target,packet:VmHandoff):Promise<{id:string;imported:boolean}> {
  // No agent, other app's key, relaxed host check, token in argv, shell, or public import endpoint.
  const args=["-F","none","-T","-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","IdentityAgent=none","-o","PasswordAuthentication=no","-o","KbdInteractiveAuthentication=no","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=15","-o",`UserKnownHostsFile=${target.knownHostsFile}`,"-i",target.identityFile,`${target.sshUser}@${target.sshHost}`,`TRADIATIVE_AUTH_DIR=${target.remoteStateDirectory} node ${target.remoteImporter}`];
  return new Promise((resolve,reject)=>{
    const child=spawn("ssh",args,{stdio:["pipe","pipe","pipe"],windowsHide:true});let output="",settled=false;
    const timer=setTimeout(()=>{child.kill();fail();},45000);
    function fail(){if(!settled){settled=true;clearTimeout(timer);reject(new Error("서버 이전 확인이 필요합니다. PC의 갱신을 잠근 채 기록을 보존했습니다. 개발자가 같은 이전을 확인·재개해야 합니다."));}}
    child.on("error",fail);child.stdin.on("error",fail);child.stderr.on("data",()=>{});
    child.stdout.on("data",data=>{output+=data.toString();if(output.length>2000){child.kill();fail();}});
    child.on("close",code=>{if(settled)return;try{const result=JSON.parse(output);if(code!==0||result.id!==packet.transfer.id||result.imported!==true)throw new Error();settled=true;clearTimeout(timer);resolve(result);}catch{fail();}});
    child.stdin.end(JSON.stringify(packet));
  });
}
export async function startConnector(directory:string,target:Target,session=new ChatGPTSession(directory,planHttp),send=sendSsh) {
  validateTarget(target);const unlock=await lockAuthDirectory(directory),app=express(),csrf=randomBytes(32).toString("base64url");let origin="",busy=false;
  app.disable("x-powered-by");app.use(express.urlencoded({extended:false,limit:"2kb"}));
  app.use((req,res,next)=>{
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(req.get("host")!==new URL(origin).host||!["127.0.0.1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress||"")||(req.method==="POST"&&(req.get("origin")!==origin||req.body?.csrf!==csrf))){res.status(403).send("이 PC 연결 도구에서 시작한 요청이 아닙니다.");return;}next();
  });
  const page=(body:string)=>`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRADIATIVE ChatGPT 연결 도구</title><style>body{font:16px/1.8 system-ui;background:#f6f6ef;color:#293c31;max-width:600px;padding:24px;margin:8vh auto}input,button{display:block;font:inherit;width:100%;box-sizing:border-box;padding:12px;margin:12px 0}button{background:#304f3b;color:white;border:0;border-radius:6px}a{color:#304f3b}</style><h1>ChatGPT 사용량 연결</h1>${body}</html>`;
  app.get("/",(_req,res)=>res.type("html").send(page(`<p>대상: <b>${escape(target.origin)}</b></p><p>이 도구에서 새로 승인한 TRADIATIVE 로그인만 서버로 이전합니다. 서버가 이후 갱신을 담당하며, 공개 작업실 주소는 입구로 계속 사용합니다.</p><p>ChatGPT 요금제·크레딧 사용량을 소비합니다. 별도 API는 꺼져 있습니다. 이전된 세션의 서버별 사용량 귀속·개별 해제는 아직 공급자가 지원하지 않습니다.</p><form method="post" action="/begin"><input name="csrf" type="hidden" value="${csrf}"><label>본인 전용 작업실 비밀번호 (최초 설정)<input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="200" required></label><p>이미 작업실이 있다면 서버의 기존 비밀번호를 유지합니다.</p><button>Continue with ChatGPT</button></form><form method="post" action="/resume"><input name="csrf" type="hidden" value="${csrf}"><button>이전 재확인</button></form><p>이전 중 중단된 경우 새 로그인 없이 같은 이전의 수신 여부를 확인합니다. 10분이 지난 미수신 이전은 개발자가 복구해야 합니다.</p>`)));
  app.post("/begin",async(req,res)=>{
    try{if(busy)throw new Error();const password=req.body?.password;if(typeof password!=="string")throw new Error();
      const prepared=await ownerPassword(password,"pending","pending");await privateWrite(directory,"pending-owner.json",prepared);
      res.redirect(303,await session.begin(origin));
    }catch{res.status(400).type("html").send(page("<p>비밀번호 길이 또는 이전 진행 상태를 확인하세요. 진행 중인 서버 이전은 개발자가 확인해야 합니다.</p><a href='/'>돌아가기</a>"));}
  });
  const transfer=async()=>{
    const packet=await session.prepareTransfer(),saved=await privateRead(directory,"pending-owner.json");
    const owner={...saved,subject:packet.credential.subject,clientId:packet.credential.clientId};
    const ack=await send(target,{transfer:packet,owner});await session.finishTransfer(ack.id);await unlink(path.join(directory,"pending-owner.json"));
  };
  app.post("/resume",async(_req,res)=>{if(busy){res.status(409).send("이미 연결 중입니다.");return;}busy=true;try{if(!session.status().transferPending)throw new Error();await transfer();res.type("html").send(page("<p>같은 이전의 수신을 확인하고 PC 갱신을 해제했습니다. 서버가 이후 갱신을 담당합니다.</p>"));}catch{res.status(400).type("html").send(page("<p>이전 수신을 아직 확인하지 못했습니다. 개발자가 서버 상태를 확인해야 합니다. 새 AI 요청은 보내지 않았습니다.</p>"));}finally{busy=false;}});
  app.get("/auth/callback",async(req,res)=>{
    if(busy){res.status(409).send("이미 연결 중입니다.");return;}busy=true;
    try{await session.callback(new URL(req.originalUrl,origin).searchParams);await transfer();res.type("html").send(page(`<h2>로그인 이전 완료</h2><p>서버가 갱신을 담당합니다. 실제 이미지 요청은 아직 미검증입니다. 개발자가 서버 실행 상태를 확인한 뒤 작업실에서 이미지 한 장을 검증합니다.</p><a href="${escape(target.origin)}" rel="noreferrer">본인 전용 작업실 열기</a>`));}
    catch{res.status(400).type("html").send(page("<p>연결이 완료되지 않았습니다. 서버가 수신했는지 불명확한 경우 PC 갱신은 계속 잠깁니다. 기존 결과는 보존했습니다. 개발자가 이전 상태를 확인해야 합니다.</p>"));}
    finally{busy=false;}
  });
  await session.initialize();
  const server=app.listen(0,"127.0.0.1");await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
  return {origin,server,close:async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await unlock();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const config=process.argv[2];if(!config)throw new Error("target missing");
    const target=validateTarget(JSON.parse(await readFile(config,"utf8")));
    const directory=path.join(homedir(),".config","tradiative-studio-connector");
    const app=await startConnector(directory,target);
    const command=process.platform==="win32"?"explorer.exe":process.platform==="darwin"?"open":"xdg-open";
    spawn(command,[app.origin],{stdio:"ignore",windowsHide:true}).on("error",()=>{process.stderr.write("브라우저 실행을 확인하세요. 인증 비밀 값은 출력하지 않았습니다.\n");});
    for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>void app.close().then(()=>process.exit(0)));
  }catch{process.stderr.write("개발자가 대상 서버·SSH 호스트 키·이 앱 전용 키를 준비한 연결 도구가 필요합니다. 사용자가 토큰이나 서버 주소를 입력할 필요는 없습니다.\n");process.exitCode=1;}
}
