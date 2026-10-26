// T10 browser flows. Product API routes are 501 until T12 wiring, so every /api/** call here is served by an in-memory
// MOCK backend through page.route with contract-valid fixtures. This checks UI behavior only, not storage or model quality.
import { expect, test } from "@playwright/test";
import { ids } from "../support/fixtures";
import { childId, id, mockApi } from "./T10.mock-api";

const calls = (state: Awaited<ReturnType<typeof mockApi>>, method: string, path: string) => state.calls.filter(c => c.method === method && c.path === path);
const generatePath = `/generate?projectId=${ids.project}&sceneId=${ids.scene}`;

test("unknown price: no submit until explicit consent, then exactly one request with no cap", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(generatePath);
  await page.getByLabel("모델", { exact: true }).selectOption("fal-flux2-edit");
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await expect(page.getByText("알 수 없음 (pricing-not-configured)")).toBeVisible();
  const submit = page.getByRole("button", { name: "생성 실행", exact: true });
  await expect(submit).toBeDisabled();
  expect(calls(state, "POST", "/api/generations")).toHaveLength(0);
  await page.getByRole("checkbox").check();
  await submit.click();
  await expect(page.getByRole("region", { name: "진행 상황" })).toBeVisible();
  const sent = calls(state, "POST", "/api/generations");
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ acceptUnknownCost: true, maxEstimatedCostMicros: null });
});

test("unknown price is blocked outright when the project has a budget", async ({ page }) => {
  const state = await mockApi(page, { budgetMicros: 5_000_000 });
  await page.goto(generatePath);
  await page.getByLabel("모델", { exact: true }).selectOption("fal-flux2-edit");
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await expect(page.getByText("가격을 모르는 요청은 제출할 수 없습니다")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeDisabled();
  await expect(page.getByRole("button", { name: "생성 실행", exact: true })).toBeDisabled();
  expect(calls(state, "POST", "/api/generations")).toHaveLength(0);
});

test("known price sends the shown estimate as the cap; preview shows order and warnings", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(generatePath);
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await expect(page.getByRole("list", { name: "제약 경고" })).toContainText("SOFT_LAYOUT");
  await expect(page.getByAltText("참조 1 character")).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "생성 실행", exact: true }).click();
  await expect.poll(() => calls(state, "POST", "/api/generations").length).toBe(1);
  expect(calls(state, "POST", "/api/generations")[0].body).toMatchObject({ acceptUnknownCost: false, maxEstimatedCostMicros: 0 });
});

test("selection survives reload and polling stops at a terminal state", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(generatePath);
  await expect(page.getByLabel("장면", { exact: true })).toHaveValue(ids.scene);
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "생성 실행", exact: true }).click();
  await expect(page).toHaveURL(/runId=/);
  await page.reload();
  await expect(page.getByLabel("장면", { exact: true })).toHaveValue(ids.scene);
  await expect(page.getByRole("status").filter({ hasText: "완료" })).toBeVisible({ timeout: 15_000 });
  const polls = state.calls.filter(c => c.method === "GET" && c.path.startsWith("/api/generations/")).length;
  await page.waitForTimeout(4_500);
  expect(state.calls.filter(c => c.method === "GET" && c.path.startsWith("/api/generations/")).length).toBe(polls);
  await expect(page.getByRole("link", { name: "평가하기" })).toBeVisible();
});

test("501 responses are shown as not implemented, never as success or empty data", async ({ page }) => {
  await mockApi(page, { projectsStatus: 501 });
  await page.goto("/projects");
  await expect(page.getByRole("alert").filter({ hasText: "미구현 (501" })).toBeVisible();
  await expect(page.getByText("아직 프로젝트가 없습니다")).toHaveCount(0);
  const state = await mockApi(page, { submitStatus: 501 });
  await page.goto(generatePath);
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "생성 실행", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "미구현 (501" })).toBeVisible();
  await expect(page.getByRole("region", { name: "진행 상황" })).toHaveCount(0);
  expect(calls(state, "POST", "/api/generations")).toHaveLength(1);
});

test("projects: create, select via URL and keep the selection after reload", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/projects");
  await expect(page.getByText("Wind Duel")).toBeVisible();
  await page.getByRole("button", { name: "선택" }).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${ids.project}`));
  await page.reload();
  await expect(page.getByText("선택됨")).toBeVisible();
  await page.getByLabel("제목").fill("  New duel  ");
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  await expect.poll(() => calls(state, "POST", "/api/projects")[0]?.body).toMatchObject({ title: "  New duel  ", budgetMicros: null });
});

test("review: edits require preservation; a mask blocks refine until removed explicitly", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(`/review?projectId=${ids.project}&candidateId=${childId}`);
  await expect(page.getByRole("heading", { name: "원본과 수정본 비교" })).toBeVisible();
  await expect(page.getByText("비대상 영역 보존")).toBeVisible();
  await page.getByRole("button", { name: "평가 저장" }).click();
  await expect.poll(() => calls(state, "POST", `/api/candidates/${childId}/review`)[0]?.body).toMatchObject({ preservation: 3 });
  await page.getByLabel("수정 지시").fill("sharper blade");
  await page.getByLabel("마스크 이미지").selectOption(ids.media);
  await expect(page.getByText("마스크 편집을 지원하지 않습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "수정 미리보기" })).toBeDisabled();
  await page.getByRole("button", { name: "마스크 제거" }).click();
  await expect(page.getByRole("button", { name: "수정 미리보기" })).toBeEnabled();
  await page.goto(`/review?projectId=${ids.project}&candidateId=${ids.candidate}`);
  await expect(page.getByText("비대상 영역 보존")).toHaveCount(0);
});

test("effects: export is disabled with unsaved changes and saving sends the stored revision", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(`/effects?projectId=${ids.project}&candidateId=${ids.candidate}`);
  const exportButton = page.getByRole("button", { name: "PNG + manifest 내보내기" });
  await expect(exportButton).toBeEnabled();
  await page.getByLabel("밝기").fill("1.5");
  await expect(exportButton).toBeDisabled();
  await page.getByRole("button", { name: "효과 저장" }).click();
  await expect.poll(() => calls(state, "PUT", `/api/candidates/${ids.candidate}/effects`)[0]?.body).toMatchObject({ expectedRevision: 0, brightness: 1.5 });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.getByRole("link", { name: "manifest 다운로드" }).first()).toHaveAttribute("href", `/api/exports/${id(960)}/manifest`);
});

test("pages without a project ask for one and mobile layouts do not overflow", async ({ page }) => {
  await mockApi(page);
  for (const path of ["/assets", "/styles", "/scenes", "/history"]) {
    await page.goto(path);
    await expect(page.getByText("먼저")).toBeVisible();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of [generatePath, `/scenes?projectId=${ids.project}&sceneId=${ids.scene}`, `/history?projectId=${ids.project}`, `/review?projectId=${ids.project}&candidateId=${childId}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth ? [] : [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(e => `${e.tagName}.${e.className}`.slice(0, 120)));
    expect(overflow, path).toEqual([]);
  }
});
