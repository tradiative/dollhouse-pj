import {readFile,writeFile,mkdir,readdir,lstat} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {zipSync,strToU8,unzipSync} from "fflate";
const files={};
async function add(file,name=file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw new Error("Non-regular distribution file");files[name]=new Uint8Array(await readFile(file));}
async function walk(root,output=root,exclude=()=>false){for(const e of await readdir(root,{withFileTypes:true})){const f=path.posix.join(root,e.name);if(exclude(f))continue;if(e.isSymbolicLink())throw new Error("Symlink not distributed");if(e.isDirectory())await walk(f,path.posix.join(output,e.name),exclude);else await add(f,path.posix.join(output,e.name));}}
for(const f of ["package.json","package-lock.json","tsconfig.json","vite.config.ts","playwright.config.ts","index.html",".dockerignore","README.md"])await add(f);
for(const dir of ["src","server","tests","docs","deploy"])await walk(dir,dir,f=>f.endsWith("reviewed.env"));
await add("scripts/build-runtime.mjs");await add("scripts/package-connection.mjs");
await add("public/favicon.svg");await add("public/THIRD-PARTY-NOTICES.txt");await walk("public/connection");
await walk("runtime/server");
await add("runtime/package.json");await add("runtime/package-lock.json");
await walk("dist","runtime/dist",f=>f.startsWith("dist/downloads/")||f.startsWith("dist/cases/"));
for(const font of ["dm-sans","noto-sans-kr"])await add(`node_modules/@fontsource-variable/${font}/LICENSE`,`dependency-licenses/${font}.txt`);
const forbidden=/(^|\/)(?:\.git|\.env[^/]*|credentials\.json|owner\.json|host\.json|transfer-pending\.json|pending-owner\.json|target\.json|runtime\.lock|tradiative_vm_ed25519|known_hosts)(\/|$)|\.(?:jpe?g|png|webp|pdf)$/i;
if(Object.keys(files).some(f=>forbidden.test(f)))throw new Error("Private data or source image must not be distributed");
files["START-HERE.txt"]=strToU8("TRADIATIVE 0.4.0 — 개발자 실행 패키지\n실제 서버·실계정 GPT 요청은 미검증입니다. 사용자 설치·즉시 연결용 앱이 아닙니다.\n코드 이용 허락 검토안은 docs/license-proposal.patch이며 아직 적용하지 않았습니다.\n배포·새 전용 SSH 키·호스트 키·OS 실행기·최초 동의는 deploy/personal-vm/README.md를 따릅니다.\n사용자 사진·도면·계정 기록·비밀 값·개인 서버 대상 설정·node_modules는 포함하지 않습니다.\n개발 환경(Node 24)에서 npm ci 후 runtime/server/index.mjs 또는 source를 실행합니다.\n이미 포함된 제작 사례가 웹앱의 실제 GPT 결과라는 의미가 아닙니다. 공개 사례 이미지·내려받기 꾸러미는 별도로 원래 공개 사이트에 보존합니다.\n");
const manifest={version:"0.4.0",sourceCommit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),actualUserOAuthVerified:false,actualImageRequests:0,licenseProposalApplied:false,sourceImagesIncluded:false,files:Object.entries(files).map(([name,b])=>({name,bytes:b.length,sha256:createHash("sha256").update(b).digest("hex")}))};
files["distribution-manifest.json"]=strToU8(JSON.stringify(manifest,null,2));
const zip=zipSync(files,{level:6}),roundtrip=unzipSync(zip);if(Object.keys(roundtrip).length!==Object.keys(files).length)throw new Error("ZIP roundtrip failed");
for(const [name,b]of Object.entries(files))if(createHash("sha256").update(roundtrip[name]).digest("hex")!==createHash("sha256").update(b).digest("hex"))throw new Error("ZIP checksum mismatch");
const folder="public/downloads/connection-v4";await mkdir(folder,{recursive:true});await writeFile(folder+"/TRADIATIVE_connection_v4_developer.zip",zip);await writeFile(folder+"/manifest.json",JSON.stringify({...manifest,zipBytes:zip.length,zipSha256:createHash("sha256").update(zip).digest("hex")},null,2)+"\n");
console.log(JSON.stringify({files:Object.keys(files).length,bytes:zip.length,sourceImagesIncluded:false,actualImageRequests:0}));
