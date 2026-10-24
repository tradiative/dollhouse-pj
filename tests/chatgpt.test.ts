import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {ChatGPTSession,readPlanStream,type Http} from "../server/chatgpt";
const AUTH="https://auth.openai.com", clientId="oaiapp_test_registration";
const key=await generateKeyPair("RS256"),jwk={...await exportJWK(key.publicKey),kid:"test-key",alg:"RS256",use:"sig"};
function stream(events:unknown[],chunk=13){const bytes=new TextEncoder().encode(events.map(e=>"data: "+JSON.stringify(e)+"\r\n\r\n").join(""));return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=chunk)c.enqueue(bytes.slice(i,i+chunk));c.close();}}),{headers:{"Content-Type":"text/event-stream"}});}
async function harness(opts:{nonce?:string;scope?:string;expired?:boolean}={}){
 const directory=await mkdtemp(path.join(tmpdir(),"tradiative-oauth-test-"));let auth:URL;let refreshes=0;let now=Date.now();const calls:Array<{url:string;body?:string}>=[];
 const http:Http=async(url,init)=>{calls.push({url,body:typeof init?.body==="string"?init.body:undefined});
  if(url.endsWith("openid-configuration"))return Response.json({issuer:AUTH,jwks_uri:AUTH+"/.well-known/jwks.json",revocation_endpoint:AUTH+"/api/accounts/oauth/revoke"});
  if(url.endsWith("jwks.json"))return Response.json({keys:[jwk]});
  if(url.endsWith("oauth/revoke"))return new Response(null,{status:200});
  if(url.endsWith("oauth/token")){
   const body=new URLSearchParams(String(init!.body));assert.equal(body.get("client_id"),clientId);assert.equal(body.get("resource"),"https://api.openai.com/v1");
   if(body.get("grant_type")==="refresh_token"){refreshes++;return Response.json({access_token:"fresh-test-access",refresh_token:"rotated-test-refresh",expires_in:3600,token_type:"Bearer",scope:"openid resource.invoke chatgpt.tokens.use.direct"});}
   assert.equal(body.get("redirect_uri"),auth!.searchParams.get("redirect_uri"));const verifier=body.get("code_verifier")!;assert.ok(verifier.length>=43);
   const jwt=await new SignJWT({nonce:opts.nonce||auth!.searchParams.get("nonce"),email:"test@example.invalid"}).setProtectedHeader({alg:"RS256",kid:"test-key"}).setSubject("subject-test").setIssuer(AUTH).setAudience(clientId).setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+(opts.expired?-10:3600)).sign(key.privateKey);
   return Response.json({access_token:"test-access",refresh_token:"test-refresh",id_token:jwt,expires_in:3600,token_type:"Bearer",scope:opts.scope||"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"});
  }
  if(url.endsWith("/models"))return Response.json({models:[{slug:"hidden",display_name:"Hidden",visibility:"hide"},{slug:"test-image-model",display_name:"Test image model",visibility:"list"}]});
  if(url.endsWith("/responses")){const body=JSON.parse(String(init!.body));assert.equal(body.store,false);assert.equal(body.stream,true);assert.ok(!("max_output_tokens" in body));return stream([{type:"response.created"},{type:"response.completed",response:{id:"test-response",status:"completed",output:[]}}]);}
  throw new Error("Unexpected mock URL");
 };
 const s=new ChatGPTSession(directory,http,()=>now);auth=new URL(await s.begin("http://127.0.0.1:32177"));
 const callback=()=>new URLSearchParams({state:auth.searchParams.get("state")!,code:"single-test-code",client_id:clientId});
 return {s,directory,http,calls,auth,callback,advance:()=>{now+=3600_000;},refreshes:()=>refreshes,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
test("official OAuth uses stable host ID, PKCE, validated identity, owner-only credentials and catalog",async()=>{
 const h=await harness();try{
 assert.equal(h.auth.searchParams.get("client_id"),"dynamic_agent_client");assert.equal(h.auth.searchParams.get("code_challenge_method"),"S256");assert.equal(h.auth.searchParams.get("agent_name_hint"),"TRADIATIVE Studio");
 await h.s.callback(h.callback());assert.equal(h.s.status().loginCompleted,true);assert.equal(h.s.status().actualRequestVerified,false);
 assert.equal((await stat(path.join(h.directory,"credentials.json"))).mode&0o777,0o600);assert.equal((await stat(h.directory)).mode&0o777,0o700);
 const models=await h.s.listModels();assert.deepEqual(models,[{slug:"test-image-model",display_name:"Test image model"}]);assert.equal(h.s.status().modelAccessVerified,true);assert.equal(h.s.status().actualRequestVerified,false);
 const second=new ChatGPTSession(h.directory,h.http);const url=new URL(await second.begin("http://127.0.0.1:32177"));assert.equal(url.searchParams.get("ext_agent_host_id"),h.auth.searchParams.get("ext_agent_host_id"));assert.equal(url.searchParams.get("client_id"),clientId);assert.ok(!url.searchParams.has("agent_name_hint"));
 const done=await h.s.infer("test-image-model",[{role:"user",content:"mock"}],"mock",new AbortController().signal);assert.equal(done.status,"completed");
 }finally{await h.cleanup();}
});
test("mismatched state, replay, nonce, expired signature and denied consent never become login success",async()=>{
 for(const option of [{nonce:"wrong"},{expired:true},{}]){const h=await harness(option);try{
 const wrong=h.callback();wrong.set("state","wrong");await assert.rejects(h.s.callback(wrong),/일치하지/);
 const q=h.callback();if(!option.nonce&&!option.expired)q.set("error","access_denied");await assert.rejects(h.s.callback(q));assert.equal(h.s.status().loginCompleted,false);await assert.rejects(h.s.callback(q));
 }finally{await h.cleanup();}}
});
test("identity-only login does not grant plan usage; concurrent refresh rotates one protected record",async()=>{
 const a=await harness({scope:"openid profile email"});try{await a.s.callback(a.callback());await assert.rejects(a.s.listModels(),/권한/);}finally{await a.cleanup();}
 const h=await harness();try{await h.s.callback(h.callback());h.advance();const tokens=await Promise.all([h.s.accessToken(),h.s.accessToken()]);assert.deepEqual(tokens,["fresh-test-access","fresh-test-access"]);assert.equal(h.refreshes(),1);assert.equal(JSON.parse(await readFile(path.join(h.directory,"credentials.json"),"utf8")).refreshToken,"rotated-test-refresh");const out=await h.s.logout();assert.equal(out.remoteRevoked,true);await assert.rejects(readFile(path.join(h.directory,"credentials.json")));assert.ok(await readFile(path.join(h.directory,"registration.json")));}finally{await h.cleanup();}
});
test("a stream beginning or HTTP 200 cannot mask interruption, incomplete, quota failure or refusal",async()=>{
 for(const events of [[{type:"response.created"}],[{type:"response.output_text.delta",delta:"{"}],[{type:"response.incomplete",response:{status:"incomplete"}}],[{type:"response.failed",response:{error:{code:"subscription_sharing_usage_limit_exceeded"}}}],[{type:"response.completed",response:{status:"completed"}}]])await assert.rejects(readPlanStream(stream(events)));
 const completed={id:"mock-completed",status:"completed",output:[{content:[{type:"output_text",text:"{}"}]}]};assert.deepEqual(await readPlanStream(stream([{type:"response.completed",response:completed}],1)),completed);
 await assert.rejects(readPlanStream(stream([{type:"error",code:"subscription_sharing_usage_limit_exceeded"}])),(e:unknown)=>(e as {state:string}).state==="limited");
 const abort=new AbortController();abort.abort();await assert.rejects(readPlanStream(stream([{type:"response.created"}]),abort.signal));
});

test("personal HTTP runtime rejects other origins and repairs a mocked structure within its request budget",async()=>{
 const express=(await import("express")).default;
 const {registerPlanRoutes}=await import("../server/planRoutes");const {programFixture}=await import("./helpers/programFixture");const {fixtureOptions}=await import("./helpers/imageFixture");
 const session=new ChatGPTSession("/tmp/not-used-tradiative-http-mock",async()=>{throw new Error("Unexpected external request");});
 let calls=0;
 session.infer=async()=>{calls++;const p=programFixture();if(calls===1)p.masses[0].width=0;return {id:"mock-request-"+calls,status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify(p)}]}]};};
 const app=express();app.use(express.json({limit:"2mb"}));registerPlanRoutes(app,session,true);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.on("listening",r));const address=server.address() as {port:number},origin="http://127.0.0.1:"+address.port;
 try{
 const payload={provider:"chatgpt-plan",model:"mock-image-model",sources:["front","side"].map(id=>({id,name:id+".png",image:"data:image/png;base64,iVBORw0KGgo="})),options:{...fixtureOptions(),maxIterations:3}};
 const wrong=await fetch(origin+"/api/design",{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://unrelated.invalid","X-TRADIATIVE-CSRF":session.csrf},body:JSON.stringify(payload)});assert.equal(wrong.status,403);assert.equal(calls,0);
 const r=await fetch(origin+"/api/design",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin,"X-TRADIATIVE-CSRF":session.csrf},body:JSON.stringify(payload)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));assert.equal(data.scene.run.requestCount,2);assert.equal(data.scene.run.engine,"chatgpt-plan");assert.equal(data.scene.masses.length,2);assert.equal(data.scene.run.inputSources.length,2);assert.ok(data.scene.run.inputSources.every((s:{sha256:string})=>/^[a-f0-9]{64}$/.test(s.sha256)));assert.equal(calls,2);
 const {request}=await import("node:http");const otherStatus=await new Promise<number>((resolve,reject)=>{const req=request(origin+"/api/ai/status",{headers:{Host:"unrelated.invalid"}},r=>{r.resume();resolve(r.statusCode!);});req.on("error",reject);req.end();});assert.equal(otherStatus,503);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
