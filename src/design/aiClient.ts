import type { Source } from "../engine";
import { readSourceFile } from "../sourceStore";
import { parseBuildingDesign } from "./parse";
import type { BuildingDesign, EstimateOptions } from "./types";
export type AiConnection = { state: string; label: string; reason: string; actualRequestVerified: boolean; remainingUsage: null; csrf?: string; plan?: { loginCompleted: boolean; modelAccessVerified: boolean; geometryVerified?:boolean; mode?:"personal-local"|"personal-vm"; lastCompleted?:{model:string;at:string;responseId:string;validDesign?:boolean}|null; models: Array<{slug: string; display_name: string}>; account?: {email: string;registration: string} | null }; capabilities?: { images: string; structuredOutput: string; search: string } };
export const DISCONNECTED: AiConnection = {state:"preparing",label:"ChatGPT 사용량 연결 준비 중",reason:"ChatGPT 사용량 연결 준비 중입니다. 별도 API 과금은 꺼져 있습니다.",actualRequestVerified:false,remainingUsage:null};
export async function connectionStatus(): Promise<AiConnection> {
  if(location.hostname.endsWith(".github.io"))return {...DISCONNECTED,reason:"ChatGPT 사용량 연결 준비 중입니다. 별도 API 과금은 꺼져 있습니다. 본인 전용 OSS 서버 경로를 준비했으며, 코드 이용 허락과 실제 서버·로그인·이미지 요청은 확인 전입니다."};
  const r=await fetch("/api/ai/status",{cache:"no-store"});if(!r.ok)return DISCONNECTED;return r.json();
}
export async function connectionAction(action: "login"|"models"|"logout", csrf: string) {
  const r=await fetch("/api/ai/"+action,{method:"POST",headers:{"Content-Type":"application/json","X-TRADIATIVE-CSRF":csrf},body:"{}"});const data=await r.json();if(!r.ok)throw new Error(data.error||"연결 작업 실패");return data;
}
export async function aiReference(source: Source, pdf?: {blob: Blob;page: number}) {
  const blob=pdf?.blob||await readSourceFile(source.id);if(!blob)throw new Error(source.name+" 원본을 찾지 못했습니다.");
  if(source.name.toLowerCase().endsWith(".pdf")&&!pdf)throw new Error(source.name+"의 분석할 PDF 페이지를 먼저 열어 주세요.");
  const bitmap=await createImageBitmap(blob);try{
    const factor=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),width=Math.max(1,Math.round(bitmap.width*factor)),height=Math.max(1,Math.round(bitmap.height*factor));
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d")!;ctx.fillStyle="white";ctx.fillRect(0,0,width,height);ctx.drawImage(bitmap,0,0,width,height);
    return {id:source.id,name:source.name,page:pdf?.page,pixelWidth:width,pixelHeight:height,image:canvas.toDataURL("image/jpeg",0.85)};
  }finally{bitmap.close();}
}
export async function requestAiDesign(connection: AiConnection, model: string, sources: Awaited<ReturnType<typeof aiReference>>[], options: EstimateOptions, previous: BuildingDesign|undefined, instruction: string, signal: AbortSignal) {
  const r=await fetch("/api/design",{method:"POST",headers:{"Content-Type":"application/json","X-TRADIATIVE-CSRF":connection.csrf||""},body:JSON.stringify({provider:"chatgpt-plan",model,sources,options,previous,instruction}),signal});
  const data=await r.json();if(!r.ok)throw new Error(data.error||"AI 이미지 요청 실패");
  if(data.state!=="completed-with-review"||!data.scene?.run?.actualAiCompleted||data.scene.run.engine!=="chatgpt-plan")throw new Error("실제 AI 완료 기록을 받지 못해 결과를 적용하지 않았습니다.");
  return parseBuildingDesign(data.scene);
}
