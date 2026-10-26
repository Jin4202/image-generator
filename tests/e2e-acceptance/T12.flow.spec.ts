// T12 full UI flow on the real production stack (scripts/e2e-stack.ts: isolated DB, worker, `next start`, mock provider).
// No page.route mocks: every request hits the wired API and the separate worker process. Mock output is a 1×1 fixture.
import { expect, test } from "@playwright/test";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";

// Same literal as scripts/e2e-stack.ts (importing that script would start a second stack).
const KEY_SENTINEL = "e2e-sentinel-fal-key-never-in-client";

test("project → upload → scene → consented mock generation → review → export → history, with no key in client code", async ({ page, request }) => {
  test.setTimeout(150_000);
  const scripts = new Set<string>();
  page.on("response", response => { if (/\/_next\/static\/.+\.js/.test(response.url())) scripts.add(response.url()); });

  await page.goto("/projects");
  await page.getByLabel("제목").fill("UI Flow");
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  await expect(page).toHaveURL(/projectId=/);
  const projectId = new URL(page.url()).searchParams.get("projectId")!;

  await page.goto(`/assets?projectId=${projectId}`);
  await page.getByLabel("업로드할 이미지").setInputFiles({ name: "ref.png", mimeType: "image/png", buffer: Buffer.from(MOCK_PNG_BASE64, "base64") });
  await page.getByRole("button", { name: "업로드", exact: true }).click();
  await expect(page.getByRole("list", { name: "프로젝트 이미지" }).getByRole("listitem")).toHaveCount(1);

  await page.goto(`/scenes?projectId=${projectId}`);
  await page.getByLabel("장면 설명").fill("Wind duel on a cliff");
  await page.getByRole("button", { name: "참조 추가" }).click();
  await page.getByLabel("참조 1 이미지").selectOption({ index: 1 });
  await page.getByRole("button", { name: "장면 만들기" }).click();
  await expect(page).toHaveURL(/sceneId=/);
  await page.getByRole("link", { name: "이 장면으로 생성" }).click();

  await expect(page.getByRole("heading", { name: "생성", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "요청 미리보기" }).click();
  await expect(page.getByAltText("참조 1 character")).toBeVisible();
  await expect(page.getByRole("button", { name: "생성 실행", exact: true })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "생성 실행", exact: true }).click();
  await expect(page.getByRole("region", { name: "진행 상황" }).getByRole("status")).toContainText("완료", { timeout: 60_000 });

  await page.getByRole("link", { name: "평가하기" }).click();
  await expect(page.getByRole("heading", { name: "평가와 수정" })).toBeVisible();
  await page.getByRole("button", { name: "평가 저장" }).click();
  await expect(page.getByText("현재 판정")).toBeVisible();

  await page.getByRole("link", { name: "효과·내보내기" }).click();
  await page.getByRole("button", { name: "PNG + manifest 내보내기" }).click();
  const manifestLink = page.getByRole("link", { name: "manifest 다운로드" }).first();
  await expect(manifestLink).toBeVisible();
  const manifest = await request.get((await manifestLink.getAttribute("href"))!);
  expect(manifest.status()).toBe(200);
  const manifestText = await manifest.text();
  expect(JSON.parse(manifestText)).toMatchObject({ schemaVersion: 1 });
  expect(manifestText).not.toContain(KEY_SENTINEL);

  await page.goto(`/history?projectId=${projectId}`);
  await page.reload();
  await expect(page.getByText("완료").first()).toBeVisible();
  await expect(page.getByAltText("후보 1").first()).toBeVisible();

  for (const path of ["/api/models", "/api/health", `/api/projects/${projectId}/workspace`]) expect(await (await request.get(path)).text(), path).not.toContain(KEY_SENTINEL);
  expect(scripts.size).toBeGreaterThan(0);
  for (const url of scripts) {
    const body = await (await request.get(url)).text();
    expect(body, url).not.toContain(KEY_SENTINEL);
    expect(body, url).not.toContain("queue.fal.run");
  }
});
