import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ChatGPTSession, type AppTransfer, type Http } from "./chatgpt";
import { privateRead, privateWrite, lockAuthDirectory } from "./privateFiles";
import { type OwnerRecord } from "./owner";
import { planHttp } from "./planTransport";

export type VmHandoff={transfer:AppTransfer;owner:OwnerRecord};
/** Stdin through a pinned SSH connection. Not mounted as an HTTP route. Runtime must be stopped. */
export async function importVm(directory:string,packet:VmHandoff,http:Http=planHttp) {
  const unlock=await lockAuthDirectory(directory);
  try{
    const hash=createHash("sha256").update(JSON.stringify(packet)).digest("hex");
    const receipt=await privateRead(directory,"import-receipt.json").catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    if(receipt?.id===packet.transfer?.id){if(receipt.hash!==hash)throw new Error("이전 기록이 바뀌었습니다.");return {id:receipt.id,imported:true};}
    const owner=packet.owner,c=packet.transfer?.credential;
    if(!owner||owner.version!==1||!/^[a-f0-9]{64}$/.test(owner.salt)||!/^[a-f0-9]{128}$/.test(owner.hash)||owner.subject!==c?.subject||owner.clientId!==c?.clientId)throw new Error("작업실 소유자 정보가 맞지 않습니다.");
    const old=await privateRead(directory,"owner.json").catch(e=>{if(e.code==="ENOENT")return null;throw e;});
    if(old&&(old.subject!==owner.subject||old.clientId!==owner.clientId))throw new Error("이 서버는 다른 계정의 작업실입니다.");
    const session=new ChatGPTSession(directory,http);
    await session.importTransfer(packet.transfer);
    if(!old)await privateWrite(directory,"owner.json",owner);
    await privateWrite(directory,"import-receipt.json",{id:packet.transfer.id,hash});
    return {id:packet.transfer.id,imported:true};
  }finally{await unlock();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const directory=process.env.TRADIATIVE_AUTH_DIR;
  try{
    if(!directory||!path.isAbsolute(directory))throw new Error("보호된 서버 저장 위치가 필요합니다.");
    let input="";for await(const data of process.stdin){input+=data.toString();if(input.length>200_000)throw new Error("이전 기록이 너무 큽니다.");}
    const result=await importVm(directory,JSON.parse(input));process.stdout.write(JSON.stringify(result));
  }catch{process.stderr.write("TRADIATIVE 서버 이전 실패: 실행부 중지·보호된 저장 위치·계정·공식 서명을 확인하세요. 비밀 값은 출력하지 않았습니다.\n");process.exitCode=1;}
}
