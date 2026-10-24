import {test,expect} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {unzipSync,strFromU8} from "fflate";
import {compileProgram} from "../../src/design/program";
import {DEFAULT_FABRICATION} from "../../src/design/types";
import {programFixture} from "../helpers/programFixture";
test("fresh workbench has no station sample; sample is explicit and survives reload",async({page})=>{
 await page.goto("/");await expect(page.getByRole("heading",{name:"새 건축 모형",exact:true})).toBeVisible();await expect(page.locator(".model-count")).toContainText("0개 파츠");await expect(page.locator(".canvas-fallback")).toContainText("아직 만들지");
 await page.getByRole("button",{name:"예시 프로젝트 열기",exact:true}).click();await expect(page.getByRole("heading",{name:"예시 건물 · 실자료 아님",exact:true})).toBeVisible();await page.reload();await expect(page.getByRole("heading",{name:"예시 건물 · 실자료 아님",exact:true})).toBeVisible();
});
test("first GPT image request is possible before actual verification; selected sources reach the same model and files (MOCK provider)",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/api/ai/status",r=>r.fulfill({json:{state:"model-access",label:"TEST MOCK · 계정 모델 권한",reason:"실제 ChatGPT 연결 아님",csrf:"test-csrf",actualRequestVerified:false,remainingUsage:null,plan:{loginCompleted:true,modelAccessVerified:true,models:[{slug:"test-only-model",display_name:"Mock image model"}]}}}));
 let captured:any;
 await page.route("**/api/design",async r=>{
  captured=r.request().postDataJSON();const p=programFixture();const map=new Map([["front",captured.sources[0].id],["side",captured.sources[1].id]]);
  for(const e of [...p.masses,...p.openings])for(const proof of e.evidence)proof.sourceId=map.get(proof.sourceId!);for(const proof of p.assumptions)proof.sourceId=map.get(proof.sourceId!);
  const scene=compileProgram(p,captured.options.size,DEFAULT_FABRICATION);scene.run={id:"test-mock-run",engine:"chatgpt-plan",state:"completed-with-review",startedAt:new Date().toISOString(),attempts:[],requestCount:1,maxRequests:3,maxIterations:3,elapsedMs:1,actualAiCompleted:true,search:"not-used",warnings:["MOCK ONLY"],model:"test-only-model"};
  await r.fulfill({json:{state:"completed-with-review",scene}});
 });
 await page.goto("/");
 const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement("canvas");c.width=200;c.height=100;const x=c.getContext("2d")!;x.fillStyle="white";x.fillRect(0,0,200,100);x.fillStyle="green";x.fillRect(10,10,180,80);return c.toDataURL("image/png").split(",")[1];}),"base64");
 await page.locator("input[type=file][multiple]").setInputFiles([{name:"front.png",mimeType:"image/png",buffer:png},{name:"side.png",mimeType:"image/png",buffer:png}]);
 await page.getByRole("checkbox",{name:"GPT 자료 선택: front.png"}).check();await page.getByRole("checkbox",{name:"GPT 자료 선택: side.png"}).check();
 const button=page.getByRole("button",{name:"ChatGPT로 설계하기",exact:true});await expect(button).toBeEnabled();await button.click();await expect(page.locator(".run-stage")).toContainText("GPT 응답 완료");
 expect(captured.provider).toBe("chatgpt-plan");expect(captured.sources).toHaveLength(2);expect(captured.model).toBe("test-only-model");expect(captured.billingConsent).toBeUndefined();
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("tradiative.studio.project.v1")!));expect(stored.design.masses).toHaveLength(2);
 await page.locator(".workflow").getByRole("button",{name:/부품 모델링/}).click();await page.getByRole("button",{name:"부품 생성",exact:true}).click();const count=await page.locator(".parts-table tbody tr").count();
 await page.getByRole("button",{name:"내보내기",exact:true}).click();const pending=page.waitForEvent("download");await page.getByRole("dialog").getByRole("button",{name:/제작 검토 꾸러미/}).click();const download=await pending,entries=unzipSync(await readFile((await download.path())!));
 expect(Object.keys(entries).filter(n=>n.startsWith("parts/")).length).toBe(count);expect(strFromU8(entries["part-list.csv"]).trim().split(/\r?\n/).length).toBe(count+1);expect(strFromU8(entries["README.txt"])).toContain("mm");expect(errors).toEqual([]);
});

test("attributed Impi drawing case restores its real preview inputs, six masses and 64 downloadable parts without claiming GPT completion",async({page})=>{
 await page.goto("/");await page.getByRole("button",{name:"임피역 도면 검토 사례 열기",exact:true}).click();await expect(page.locator(".run-stage")).toContainText("GPT API 자동생성 아님",{timeout:20000});
 const p=await page.evaluate(()=>JSON.parse(localStorage.getItem("tradiative.studio.project.v1")!));expect(p.design.masses).toHaveLength(6);expect(p.design.run).toBeUndefined();expect(p.sources).toHaveLength(5);
 const ids=new Set(p.sources.map((s:{id:string})=>s.id));expect(p.design.masses.flatMap((m:{evidence:Array<{sourceId:string}>})=>m.evidence).every((e:{sourceId:string})=>ids.has(e.sourceId))).toBe(true);
 await expect(page.getByRole("img",{name:"분석 원본 이미지",exact:true})).toHaveJSProperty("naturalWidth",500);await expect(page.locator(".model-count")).toContainText("64개 파츠");
 await page.locator(".model-card").screenshot({path:"test-results/impi-case-model.png"});
 await page.locator(".workflow").getByRole("button",{name:/부품 모델링/}).click();await page.getByRole("button",{name:"부품 생성",exact:true}).click();await page.getByRole("button",{name:"내보내기",exact:true}).click();const pending=page.waitForEvent("download");await page.getByRole("dialog").getByRole("button",{name:/제작 검토 꾸러미/}).click();const d=await pending,entries=unzipSync(await readFile((await d.path())!));expect(Object.keys(entries).filter(n=>n.startsWith("parts/")).length).toBe(64);expect(JSON.parse(strFromU8(entries["project.json"])).parts).toHaveLength(64);
});
