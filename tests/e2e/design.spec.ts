import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import DxfParser from "dxf-parser";

async function image(page: Page, count: number, blank = false) {
  return Buffer.from(await page.evaluate(({ count, blank }) => {
    const c = document.createElement("canvas"); c.width = 360; c.height = 250;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0,0,360,250);
    if (!blank) {
      ctx.fillStyle = "rgb(205,195,170)"; ctx.beginPath(); ctx.moveTo(25,225); ctx.lineTo(335,225); ctx.lineTo(335,85); ctx.lineTo(180,30); ctx.lineTo(25,85); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgb(35,60,80)";
      for (let i = 0; i < count; i++) ctx.fillRect(Math.round(50 + i * 245 / Math.max(1,count-1)),135,20,65);
    }
    return c.toDataURL("image/png").split(",")[1];
  }, { count, blank }), "base64");
}
async function upload(page: Page, name: string, count = 2, blank = false) {
  await page.locator("input[type=file][multiple]").setInputFiles({ name, mimeType: "image/png", buffer: await image(page,count,blank) });
  await page.getByRole("combobox",{name:"분석할 자료",exact:true}).selectOption({ label: name });
}
async function design(page: Page) {
  await page.getByRole("button",{name:"이미지에서 외형 추정",exact:true}).click();
  await expect(page.locator(".run-stage")).toContainText("검토용 결과 생성",{timeout:30000});
}
async function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("tradiative.studio.project.v1")!));
}
test("real browser pixel analysis changes window count; no AI request or measured-scale claim", async ({page}) => {
  const errors: string[]=[], calls: string[]=[];
  page.on("pageerror",e=>errors.push(e.message)); page.on("request",r=>{if(/\/api\/(design|analyze)$/.test(r.url()))calls.push(r.url());});
  await page.goto("/"); await upload(page,"two-windows.png",2);
  await expect(page.locator(".model-footer .model-count")).toContainText("0개 파츠");
  await expect(page.locator(".canvas-fallback")).toContainText("아직 만들지");
  await design(page);
  let p=await stored(page);
  expect(p.design.elements.filter((e: {kind:string;provenance:string})=>e.kind==="opening"&&e.provenance==="observed")).toHaveLength(2);
  expect(p.design.size).toEqual({mode:"target-width",targetWidthMm:300});
  expect(p.design.run.actualAiCompleted).toBe(false);
  await upload(page,"four-windows.png",4); await design(page); p=await stored(page);
  expect(p.design.elements.filter((e: {kind:string;provenance:string})=>e.kind==="opening"&&e.provenance==="observed")).toHaveLength(4);
  await expect(page.locator(".model-footer")).toContainText("목표 모형 mm");
  await expect(page.getByRole("button",{name:/ChatGPT로 설계하기/})).toBeDisabled();
  expect(calls).toEqual([]); expect(errors).toEqual([]);
});
test("locked element survives another element edit and undo; source/geometry survive reload",async({page})=>{
  await page.goto("/"); await upload(page,"editable.png"); await design(page);
  await page.locator(".element-list button").filter({hasText:"창문 후보 2"}).click();
  await page.getByRole("button",{name:"요소 잠금",exact:true}).click();
  const before=await stored(page), locked=before.design.elements.find((e:{locked:boolean;kind:string})=>e.locked&&e.kind==="opening");
  await page.locator(".element-list button").filter({hasText:"창문 후보 1"}).click();
  await page.getByRole("textbox",{name:"선택 요소 수정 요청"}).fill("오른쪽으로 2mm");
  await page.getByRole("button",{name:"수정 요청 적용",exact:true}).click();
  const changed=await stored(page);
  expect(changed.design.elements.find((e:{id:string})=>e.id===locked.id)).toEqual(locked);
  expect(changed.design.revision).toBeGreaterThan(before.design.revision);
  await page.getByRole("button",{name:"이전 형상으로"}).click();
  expect((await stored(page)).design).toEqual(before.design);
  await page.reload();
  await expect(page.getByRole("img",{name:"분석 원본 이미지",exact:true})).toBeVisible();
  await expect(page.getByRole("img",{name:"분석 원본 이미지",exact:true})).toHaveJSProperty("naturalWidth",360);
  expect((await stored(page)).design.elements.find((e:{id:string})=>e.id===locked.id).locked).toBe(true);
});
test("downloaded SVG/DXF/STL/JSON reopen and complete ZIP restores originals with geometry",async({page,browser})=>{
  await page.goto("/"); await upload(page,"backup-reference.png"); await design(page);
  await page.locator(".workflow").getByRole("button",{name:/부품 모델링/}).click();
  await page.getByRole("button",{name:"부품 생성",exact:true}).click();
  const p=await stored(page), expectedParts=await page.locator(".parts-table tbody tr").count();
  await page.getByRole("button",{name:"내보내기",exact:true}).click();
  for(const format of ["SVG","DXF","STL","JSON"]){
    const pending=page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button",{name:new RegExp(format)}).click();
    const download=await pending, bytes=await readFile((await download.path())!);
    expect(bytes.length).toBeGreaterThan(100);
    expect(download.suggestedFilename()).toContain("목표폭-300mm");
    if(format==="SVG"){expect(bytes.toString()).toContain("실물 축척 미확인");expect(bytes.toString()).not.toContain("1:80");}
    if(format==="DXF"){const dxf=new DxfParser().parseSync(bytes.toString())!;expect(dxf.header.$INSUNITS).toBe(4);expect(new Set(dxf.entities.map(e=>e.layer)).size).toBe(expectedParts);}
    if(format==="STL")expect(bytes.toString()).toContain("facet normal");
    if(format==="JSON"){const json=JSON.parse(bytes.toString());expect(json.parts).toHaveLength(expectedParts);expect(json.schema).toBe("tradiative.project.v2");expect(json.design.observations).toHaveLength(1);}
  }
  await page.getByRole("button",{name:"닫기",exact:true}).click();
  const pending=page.waitForEvent("download");await page.getByRole("button",{name:"원본 포함 백업",exact:true}).click();
  const zip=await pending, data=await readFile((await zip.path())!), entries=unzipSync(data), metadata=JSON.parse(strFromU8(entries["project.json"]));
  expect(metadata.sourceFiles).toHaveLength(1);expect(entries[metadata.sourceFiles[0].path].length).toBeGreaterThan(100);
  const context=await browser.newContext(), restored=await context.newPage();
  await restored.goto(page.url());
  await restored.locator('input[type=file][accept=".zip"]').setInputFiles({name:"backup.zip",mimeType:"application/zip",buffer:data});
  await expect(restored.locator(".run-stage")).toContainText("백업 복원 완료",{timeout:20000});
  const recovered=await stored(restored);
  expect(recovered.design.elements.map((e:{outline:unknown})=>e.outline)).toEqual(p.design.elements.map((e:{outline:unknown})=>e.outline));
  await expect(restored.getByRole("img",{name:"분석 원본 이미지",exact:true})).toHaveJSProperty("naturalWidth",360);
  expect(recovered.sources.find((s:{name:string})=>s.name==="backup-reference.png").id).not.toBe(metadata.sourceFiles[0].id);
  await context.close();
});
test("failed blank-image analysis preserves last valid model and never marks it as new completion",async({page})=>{
  await page.goto("/");await upload(page,"valid.png");await design(page);
  const before=(await stored(page)).design;
  await upload(page,"blank.png",0,true);await page.getByRole("button",{name:"이미지에서 외형 추정",exact:true}).click();
  await expect(page.locator(".run-stage")).toContainText("실패");
  await expect(page.getByRole("alert")).toContainText("윤곽");
  expect((await stored(page)).design).toEqual(before);
});
test("ChatGPT denied/login and unchosen billing never start a generation",async({request})=>{
  const state=await(await request.get("/api/ai/status")).json();
  expect(state.state).toBe("disconnected");expect(state.remainingUsage).toBe(null);expect(state.plan.models).toEqual([]);
  const login=await request.post("/api/ai/login",{data:{}});
  expect(login.status()).toBe(503);
  const plan=await request.post("/api/design",{data:{provider:"chatgpt-plan",billingConsent:true}});
  expect(plan.status()).toBe(503);expect((await plan.json()).state).toBe("unsupported");
  const separate=await request.post("/api/design",{data:{provider:"separate-api",billingConsent:false}});
  expect(separate.status()).toBe(403);
});
test("new controls and element inspector fit a phone viewport",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto("/");
  await upload(page,"mobile.png");await design(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
function pdfFixture() {
  const content = (count: number) => {
    let s = "1 1 1 rg 0 0 360 250 re f\n0.804 0.765 0.667 rg 25 25 m 335 25 l 335 165 l 180 220 l 25 165 l h f\n0.137 0.235 0.314 rg\n";
    for (let i=0;i<count;i++) s += Math.round(50+i*245/Math.max(1,count-1)) + " 50 20 65 re f\n";
    return s;
  };
  const a=content(2),b=content(4);
  const objects=[
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 250] /Resources << >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 250] /Resources << >> /Contents 6 0 R >>",
    "<< /Length "+Buffer.byteLength(a)+" >>\nstream\n"+a+"endstream",
    "<< /Length "+Buffer.byteLength(b)+" >>\nstream\n"+b+"endstream",
  ];
  let pdf="%PDF-1.4\n";const offsets:number[]=[];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+" 0 obj\n"+o+"\nendobj\n";});
  const xref=Buffer.byteLength(pdf);
  pdf+="xref\n0 7\n0000000000 65535 f \n"+offsets.map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF\n";
  return Buffer.from(pdf);
}
test("selected PDF page is rasterized and its own four openings/source page are preserved",async({page})=>{
  await page.goto("/");
  await page.locator("input[type=file][multiple]").setInputFiles({name:"two-page-reference.pdf",mimeType:"application/pdf",buffer:pdfFixture()});
  await page.getByRole("combobox",{name:"분석할 자료",exact:true}).selectOption({label:"two-page-reference.pdf"});
  await page.getByRole("spinbutton",{name:"PDF 분석 페이지"}).fill("2");
  await page.getByRole("button",{name:"페이지 이미지 열기",exact:true}).click();
  await expect(page.locator(".run-stage")).toContainText("PDF 2/2 페이지 준비",{timeout:30000});
  await design(page);
  const p=await stored(page);
  expect(p.design.observations[0].page).toBe(2);
  expect(p.design.elements.filter((e:{kind:string;provenance:string})=>e.kind==="opening"&&e.provenance==="observed")).toHaveLength(4);
});
test("cancelling an in-flight image job does not turn it into successful AI or sample completion",async({page})=>{
  await page.goto("/");await upload(page,"cancel-reference.png");
  await page.route("**/*imageWorker*",async route=>{await new Promise(r=>setTimeout(r,1200));await route.continue().catch(()=>{});});
  await page.getByRole("button",{name:"이미지에서 외형 추정",exact:true}).click();
  await page.getByRole("button",{name:"취소",exact:true}).click();
  await expect(page.locator(".run-stage")).toContainText("취소됨");
  expect((await stored(page)).design).toBeUndefined();
});
