import {test} from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {request as httpRequest} from "node:http";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {ChatGPTSession,readPlanStream,type Http,type AppTransfer} from "../server/chatgpt";
import {registerOwnerGate,ownerPassword,vmSettings} from "../server/owner";
import {privateWrite,lockAuthDirectory} from "../server/privateFiles";
import {importVm} from "../server/vmImport";
import {startConnector,validateTarget} from "../server/connector";
import {registerPlanRoutes} from "../server/planRoutes";
import {fixtureOptions} from "./helpers/imageFixture";
const AUTH="https://auth.openai.com",CLIENT="oaiapp_v4_mock";
const key=await generateKeyPair("RS256"),jwk={...await exportJWK(key.publicKey),kid:"v4-mock",alg:"RS256"};
async function setup(){
  const directory=await mkdtemp(path.join(tmpdir(),"tradiative-vm-test-"));let auth:URL;let refreshes=0;
  const http:Http=async(url,init)=>{
    if(url.endsWith("openid-configuration"))return Response.json({issuer:AUTH,jwks_uri:AUTH+"/jwks"});
    if(url.endsWith("/jwks"))return Response.json({keys:[jwk]});
    if(url.endsWith("oauth/token")){
      const form=new URLSearchParams(String(init?.body));if(form.get("grant_type")==="refresh_token")refreshes++;
      return Response.json({access_token:"mock-access",refresh_token:"mock-refresh",id_token:await new SignJWT({nonce:auth.searchParams.get("nonce"),email:"mock@example.invalid"}).setProtectedHeader({alg:"RS256",kid:"v4-mock"}).setSubject("owner-mock").setIssuer(AUTH).setAudience(CLIENT).setIssuedAt().setExpirationTime("1h").sign(key.privateKey),token_type:"Bearer",expires_in:3600,scope:"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"});
    }
    throw new Error("Unexpected mock URL");
  };
  const session=new ChatGPTSession(directory,http);
  async function login(){auth=new URL(await session.begin("http://127.0.0.1:34567"));await session.callback(new URLSearchParams({state:auth.searchParams.get("state")!,client_id:CLIENT,code:"mock-code"}));}
  return {directory,session,http,login,setAuth:(u:URL)=>{auth=u;},refreshes:()=>refreshes,clean:()=>rm(directory,{recursive:true,force:true})};
}
const target={version:1,ossReviewed:true,origin:"https://studio.example.org",sshHost:"vm.example.org",sshUser:"tradiative",identityFile:"/configured/tradiative_vm_ed25519",knownHostsFile:"/configured/known_hosts",remoteImporter:"/opt/tradiative/server/vmImport.mjs",remoteStateDirectory:"/var/lib/tradiative"} as const;
test("VM config fails closed; the connector cannot accept arbitrary callbacks, SSH keys or commands",()=>{
  assert.equal(vmSettings({}),undefined);
  for(const change of [{},{TRADIATIVE_OSS_REVIEWED:"true"},{TRADIATIVE_OSS_REVIEWED:"true",TRADIATIVE_PUBLIC_ORIGIN:"http://studio.example.org"}])assert.throws(()=>vmSettings({TRADIATIVE_CHATGPT_MODE:"personal-vm",...change}));
  assert.ok(vmSettings({TRADIATIVE_CHATGPT_MODE:"personal-vm",TRADIATIVE_OSS_REVIEWED:"true",TRADIATIVE_PUBLIC_ORIGIN:target.origin,TRADIATIVE_AUTH_DIR:"/var/lib/tradiative"}));
  assert.throws(()=>vmSettings({TRADIATIVE_CHATGPT_MODE:"personal-vm",TRADIATIVE_OSS_REVIEWED:"true",TRADIATIVE_PUBLIC_ORIGIN:target.origin,TRADIATIVE_AUTH_DIR:"/var/lib/tradiative",TRADIATIVE_ALLOW_SEPARATE_API:"true"}));
  for(const change of [{origin:"http://bad.example.org"},{sshHost:"-oProxyCommand=bad"},{remoteImporter:"/opt/x;bad"},{identityFile:"/other/app/token"}])assert.throws(()=>validateTarget({...target,...change}));
});
test("app-owned OAuth transfer retains VM host, freezes source refresh, verifies signature and acknowledges idempotently",async()=>{
  const a=await setup(),vm=await mkdtemp(path.join(tmpdir(),"tradiative-vm-dest-"));
  try{
    await a.login();const destination=new ChatGPTSession(vm,a.http);await destination.initialize();const before=await readFile(path.join(vm,"host.json"),"utf8");
    const transfer=await a.session.prepareTransfer();await assert.rejects(a.session.accessToken(),/이전/);
    const restarted=new ChatGPTSession(a.directory,a.http);await restarted.initialize();await assert.rejects(restarted.accessToken(),/이전/);await assert.rejects(restarted.logout(),/이전/);
    const owner=await ownerPassword("v4 mock owner password",transfer.credential.subject,transfer.credential.clientId),packet={transfer,owner};
    const tampered:AppTransfer=structuredClone(transfer);tampered.credential.subject="another-owner";
    await assert.rejects(new ChatGPTSession(vm,a.http).importTransfer(tampered),/서명/);
    const first=await importVm(vm,packet,a.http);assert.equal(first.imported,true);assert.equal(await readFile(path.join(vm,"host.json"),"utf8"),before);assert.notEqual(before,await readFile(path.join(a.directory,"host.json"),"utf8"));
    assert.deepEqual(await importVm(vm,packet,a.http),first);
    assert.equal((await stat(path.join(vm,"credentials.json"))).mode&0o777,0o600);
    await a.session.finishTransfer(first.id);await assert.rejects(readFile(path.join(a.directory,"credentials.json")));assert.equal(a.session.status().loginCompleted,false);assert.equal(a.refreshes(),0);
    const active=new ChatGPTSession(vm,a.http);assert.equal((await active.initialize()).actualRequestVerified,false);assert.equal(await active.accessToken(),"mock-access");
    const unlock=await lockAuthDirectory(vm);try{await assert.rejects(importVm(vm,packet,a.http),/EEXIST/);}finally{await unlock();}
  }finally{await a.clean();await rm(vm,{recursive:true,force:true});}
});
test("remote workroom rejects anonymous, wrong Host/Origin and wrong password; owner gets secure session and CSRF",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"tradiative-owner-test-")),app=express();app.use(express.urlencoded({extended:false}));
  await privateWrite(directory,"owner.json",await ownerPassword("correct mock password", "owner-mock",CLIENT));
  const policy=registerOwnerGate(app,{origin:target.origin,directory});app.use(express.json());
  const session=new ChatGPTSession(directory,async()=>{throw new Error("No real provider request");});registerPlanRoutes(app,session,true,policy);app.get("/",(_req,res)=>res.send("private workroom"));
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const base="http://127.0.0.1:"+(server.address() as {port:number}).port;
  // Native fetch deliberately ignores an overridden Host. Model the TLS proxy's Host with node:http.
  const fetch=(url:string,init:RequestInit={})=>new Promise<globalThis.Response>((resolve,reject)=>{const req=httpRequest(url,{method:init.method||"GET",headers:init.headers as Record<string,string>},res=>{const chunks:Buffer[]=[];res.on("data",b=>chunks.push(b));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(","):v!]))})));});req.on("error",reject);req.end(init.body?.toString());});
  const headers={Host:new URL(target.origin).host,Origin:target.origin};
  try{
    assert.equal((await fetch(base+"/api/ai/status",{headers})).status,401);
    assert.equal((await fetch(base+"/api/ai/status",{headers:{...headers,Host:"attacker.example.org"}})).status,403);
    assert.equal((await fetch(base+"/api/design",{method:"POST",headers:{...headers,Origin:"https://attacker.example.org","Content-Type":"application/json"},body:"{}"})).status,403);
    assert.equal((await fetch(base+"/owner/login",{method:"POST",headers:{...headers,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({password:"wrong mock password"})})).status,403);
    const login=await fetch(base+"/owner/login",{method:"POST",redirect:"manual",headers:{...headers,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({password:"correct mock password"})});assert.equal(login.status,303);
    const set=login.headers.get("set-cookie")!;assert.match(set,/HttpOnly; Secure; SameSite=Strict/);const Cookie=set.split(";")[0];
    const status=await (await fetch(base+"/api/ai/status",{headers:{...headers,Cookie}})).json();assert.equal(status.plan.mode,"personal-vm");assert.ok(status.csrf);assert.equal(status.actualRequestVerified,false);assert.ok(!JSON.stringify(status).includes("mock-refresh"));
    assert.equal((await fetch(base+"/api/ai/login",{method:"POST",headers:{...headers,Cookie,"X-TRADIATIVE-CSRF":"wrong"}})).status,403);
    assert.equal((await fetch(base+"/api/ai/login",{method:"POST",headers:{...headers,Cookie,"X-TRADIATIVE-CSRF":status.csrf}})).status,503);
    await fetch(base+"/api/owner/logout",{method:"POST",headers:{...headers,Cookie}});assert.equal((await fetch(base+"/api/ai/status",{headers:{...headers,Cookie}})).status,401);
    const parallel=await Promise.all(Array.from({length:7},()=>fetch(base+"/owner/login",{method:"POST",headers:{...headers,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({password:"wrong mock password"})})));assert.equal(parallel.filter(r=>r.status===403).length,6);assert.equal(parallel.filter(r=>r.status===429).length,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
test("completed provider call with invalid geometry remains distinguishable; bounded retry does not fake success",async()=>{
  const a=await setup(),app=express();app.use(express.json());registerPlanRoutes(app,a.session,true);let calls=0;
  a.session.infer=async()=>{calls++;return {id:"mock-completed-invalid",status:"completed",output:[{content:[{type:"output_text",text:"{}"}]}]};};
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
  try{
    const r=await fetch(origin+"/api/design",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-TRADIATIVE-CSRF":a.session.csrf},body:JSON.stringify({provider:"chatgpt-plan",model:"mock",sources:[{id:"front",name:"building.png",image:"data:image/png;base64,iVBORw0KGgo="}],options:{...fixtureOptions(),maxIterations:1}})});
    assert.equal(r.status,400);assert.equal(calls,1);assert.equal(a.session.status().actualRequestVerified,true);assert.equal(a.session.status().geometryVerified,false);assert.equal(a.session.lastCompleted!.requestCount,1);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await a.clean();}
});
test("PC connector uses its actual loopback listener and transfers no credential to browser HTML",async()=>{
  const a=await setup();let packetSeen=false;const connector=await startConnector(a.directory,target,a.session,async(_t,packet)=>{packetSeen=true;assert.equal(packet.transfer.credential.refreshToken,"mock-refresh");return {id:packet.transfer.id,imported:true};});
  try{
    const html=await (await fetch(connector.origin)).text();const csrf=/name="csrf" type="hidden" value="([^"]+)"/.exec(html)![1];
    const start=await fetch(connector.origin+"/begin",{method:"POST",redirect:"manual",headers:{Origin:connector.origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({csrf,password:"correct connector password"})});
    const auth=new URL(start.headers.get("location")!);a.setAuth(auth);assert.equal(auth.searchParams.get("redirect_uri"),connector.origin+"/auth/callback");
    const callback=await fetch(connector.origin+"/auth/callback?"+new URLSearchParams({state:auth.searchParams.get("state")!,client_id:CLIENT,code:"mock-code"}));const result=await callback.text();assert.equal(callback.status,200);assert.equal(packetSeen,true);assert.match(result,/로그인 이전 완료/);assert.ok(!/mock-refresh|mock-access|code_verifier/.test(result));assert.equal(a.session.status().loginCompleted,false);
    assert.equal((await fetch(connector.origin+"/begin",{method:"POST",headers:{Origin:"https://attacker.example.org"},body:""})).status,403);
  }finally{await connector.close();await a.clean();}
});
test("cancelling a stalled response cancels the reader and never becomes completed inference",async()=>{
  let cancelled=false;const abort=new AbortController();
  const stream=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));},cancel(){cancelled=true;}}));
  const pending=readPlanStream(stream,abort.signal);setTimeout(()=>abort.abort(),10);
  await assert.rejects(pending,/취소/);assert.equal(cancelled,true);
});
test("closing the browser job propagates cancellation to the provider boundary without a retry",async()=>{
  const a=await setup(),app=express();app.use(express.json());registerPlanRoutes(app,a.session,true);
  let calls=0;let started!:()=>void,stopped!:()=>void;const ready=new Promise<void>(r=>{started=r;}),cancelled=new Promise<void>(r=>{stopped=r;});
  a.session.infer=async(_model,_input,_instructions,signal)=>{calls++;started();return new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>{stopped();reject(new Error("mock cancelled"));},{once:true});});};
  const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const origin="http://127.0.0.1:"+(server.address() as {port:number}).port,abort=new AbortController();
  try{
    const pending=fetch(origin+"/api/design",{method:"POST",signal:abort.signal,headers:{Origin:origin,"Content-Type":"application/json","X-TRADIATIVE-CSRF":a.session.csrf},body:JSON.stringify({provider:"chatgpt-plan",model:"mock",sources:[{id:"front",name:"building.png",image:"data:image/png;base64,iVBORw0KGgo="}],options:{...fixtureOptions(),maxIterations:3}})});await ready;abort.abort();await assert.rejects(pending);await cancelled;assert.equal(calls,1);assert.equal(a.session.lastCompleted,undefined);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await a.clean();}
});
