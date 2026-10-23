import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("dimension → generation → review → downloadable drawing, then invalidation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "임피역 본관", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".model-canvas canvas")).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "건물 너비", exact: true })
    .fill("14400");
  await expect(page.locator(".model-footer")).toContainText("180.0");
  await page
    .getByRole("checkbox", {
      name: "원본 자료와 입력 치수의 출처·단위를 대조했습니다.",
    })
    .check();
  await page.getByRole("button", { name: "부품 모델링으로" }).click();
  await page.getByRole("button", { name: "부품 생성", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "부품 다시 생성" }),
  ).toBeVisible();
  await expect(page.locator(".parts-table tbody tr")).toHaveCount(34);
  await page.getByRole("textbox", { name: "파츠 검색" }).fill("W-01");
  await expect(page.locator(".parts-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "검수로 이동" }).click();
  await expect(page.locator(".review-total")).toContainText("4");
  await page
    .getByRole("textbox", { name: "실물 시험 기록" })
    .fill("1.5 mm 자작 합판으로 시험. 창틀 조립 여유 확인.");
  await page
    .getByRole("checkbox", { name: "시험 가공과 조립 결과를 확인했습니다." })
    .check();
  await expect(page.locator(".readiness-number")).toContainText("100");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /벡터 도안 SVG/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/1-80_검토용.svg$/);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .locator(".workflow")
    .getByRole("button", { name: /설계 기준/ })
    .click();
  await page
    .getByRole("spinbutton", { name: "건물 너비", exact: true })
    .fill("15000");
  await page.locator(".workflow").getByRole("button", { name: /검수/ }).click();
  await expect(
    page.getByRole("textbox", { name: "실물 시험 기록" }),
  ).toHaveValue("1.5 mm 자작 합판으로 시험. 창틀 조립 여유 확인.");
  await expect(
    page.getByRole("checkbox", {
      name: "시험 가공과 조립 결과를 확인했습니다.",
    }),
  ).not.toBeChecked();
  await page
    .locator(".workflow")
    .getByRole("button", { name: /부품 모델링/ })
    .click();
  await expect(
    page.getByRole("button", { name: "부품 생성", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("source file import reads CSV candidates and persists without claiming they are verified", async ({
  page,
}) => {
  // Exercise local text extraction even when a future instance has a real key.
  // Automated browser validation must never incur a live AI request.
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, aiConfigured: false } }),
  );
  await page.goto("/");
  await page
    .locator(".workflow")
    .getByRole("button", { name: /자료 수집/ })
    .click();
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles({
      name: "measurements.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("width,16000\ndepth,8000"),
    });
  await expect(page.locator(".source-info")).toContainText([
    "임피역_정면입면도.svg",
    "건축물_기초치수.csv",
    "measurements.csv",
  ]);
  await page.getByRole("button", { name: "자료 분석", exact: true }).click();
  await expect(page.locator(".candidates")).toContainText("16,000");
  await page.getByRole("button", { name: "제안 치수 반영" }).click();
  await expect(
    page.getByRole("spinbutton", { name: "건물 너비", exact: true }),
  ).toHaveValue("16000");
  await expect(
    page.getByRole("checkbox", {
      name: "원본 자료와 입력 치수의 출처·단위를 대조했습니다.",
    }),
  ).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("spinbutton", { name: "건물 너비", exact: true }),
  ).toHaveValue("16000");
});
test("missing AI credentials are explicit; invalid geometry blocks generation", async ({
  page,
  request,
}) => {
  const health = await (await request.get("/api/health")).json();
  const r = await request.post("/api/analyze", { data: { sources: [] } });
  expect(r.status()).toBe(health.aiConfigured ? 400 : 503);
  await page.goto("/");
  await page
    .getByRole("spinbutton", { name: "창문 너비", exact: true })
    .fill("10000");
  await expect(page.locator(".warning-box")).toContainText("부족");
  await page.getByRole("button", { name: "부품 모델링으로" }).click();
  await expect(
    page.getByRole("button", { name: "부품 생성", exact: true }),
  ).toBeDisabled();
});
test("mobile navigation and dialog work without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "작업 가이드", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "메뉴 닫기" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("original image survives reload in IndexedDB and stays out of project metadata", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".workflow")
    .getByRole("button", { name: /자료 수집/ })
    .click();
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles({
      name: "reference.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await page
    .getByRole("button", { name: "reference.png 열기", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("img", { name: "reference.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("img", { name: "reference.png" }),
  ).toHaveJSProperty("naturalWidth", 1);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("tradiative.studio.project.v1"),
    ),
  ).not.toContain("data:image");
  await page.reload();
  await page
    .locator(".workflow")
    .getByRole("button", { name: /자료 수집/ })
    .click();
  await expect(page.locator(".source-thumbnail img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  await page
    .getByRole("button", { name: "reference.png 열기", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "원본 파일 다운로드" }),
  ).toBeVisible();
});

test("portable JSON restores dimensions and notes while requiring new verification", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("spinbutton", { name: "건물 너비", exact: true })
    .fill("14400");
  await page.locator(".workflow").getByRole("button", { name: /검수/ }).click();
  await page
    .getByRole("textbox", { name: "실물 시험 기록" })
    .fill("이전 시험 기록을 보존합니다.");
  await page.getByRole("button", { name: "내보내기", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /프로젝트 데이터 JSON/ }).click();
  const file = await pending;
  const data = await readFile((await file.path())!);
  const parsed = JSON.parse(data.toString());
  expect(parsed.schema).toBe("tradiative.project.v1");
  expect(parsed.dimensions.width).toBe(14400);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json"]')
    .setInputFiles({
      name: "project.json",
      mimeType: "application/json",
      buffer: data,
    });
  await expect(
    page.getByRole("spinbutton", { name: "건물 너비", exact: true }),
  ).toHaveValue("14400");
  await expect(
    page.getByRole("checkbox", {
      name: "원본 자료와 입력 치수의 출처·단위를 대조했습니다.",
    }),
  ).not.toBeChecked();
  await page.locator(".workflow").getByRole("button", { name: /검수/ }).click();
  await expect(
    page.getByRole("textbox", { name: "실물 시험 기록" }),
  ).toHaveValue("이전 시험 기록을 보존합니다.");
  await expect(
    page.getByRole("checkbox", {
      name: "시험 가공과 조립 결과를 확인했습니다.",
    }),
  ).not.toBeChecked();
});
