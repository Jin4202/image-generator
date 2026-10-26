// T17 project edit/delete UI on the real production stack (no API mocks).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function newProject(request: APIRequestContext, title: string) {
  const response = await request.post("/api/projects", { data: { title, budgetMicros: null } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as { id: string; revision: number };
}
const item = (page: Page, title: string) => page.getByRole("listitem", { name: `프로젝트 ${title}` });
function mutations(page: Page) {
  const seen: string[] = [];
  page.on("request", r => { if (["PATCH", "DELETE"].includes(r.method())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return seen;
}

test("edit title and budget; validation; persisted after reload", async ({ page, request }) => {
  const title = `Edit ${Date.now()}`;
  await newProject(request, title);
  await page.goto("/projects");
  await item(page, title).getByRole("button", { name: "편집" }).click();
  const form = page.getByRole("group", { name: "프로젝트 편집" });
  await form.getByLabel("제목").fill("  ");
  await expect(form.getByRole("button", { name: "변경 저장" })).toBeDisabled();
  await form.getByLabel("예산 (USD, 선택)").fill("-1");
  await expect(form.getByText("예산은 0 이상의 숫자여야 합니다.")).toBeVisible();
  await form.getByLabel("제목").fill(`${title} renamed`);
  await form.getByLabel("예산 (USD, 선택)").fill("2.5");
  await expect(form.getByText("취소·환급되지 않습니다", { exact: false })).toBeVisible();
  await form.getByRole("button", { name: "변경 저장" }).click();
  await expect(item(page, `${title} renamed`)).toContainText("$2.50");
  await page.reload();
  await expect(item(page, `${title} renamed`)).toContainText("$2.50");
});

test("cancel sends nothing; confirmed delete removes the project and clears the selection; other screens report 404", async ({ page, context, request }) => {
  const title = `Delete ${Date.now()}`;
  const project = await newProject(request, title);
  const scene = (await (await request.post("/api/scenes", { data: { projectId: project.id, content: { prompt: "Doomed", camera: "", size: { width: 1024, height: 1024 }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] } } })).json()).data;
  const seen = mutations(page);
  await page.goto(`/projects?projectId=${project.id}&sceneId=${scene.id}`);
  await item(page, title).getByRole("button", { name: "삭제" }).click();
  const dialog = page.getByRole("alertdialog", { name: "프로젝트 삭제 확인" });
  await expect(dialog).toContainText(`‘${title}’`);
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  expect(seen).toEqual([]);

  const other = await context.newPage();
  await other.goto(`/scenes?projectId=${project.id}&sceneId=${scene.id}`);
  await expect(other.getByRole("button", { name: /Doomed/ })).toBeVisible();

  await item(page, title).getByRole("button", { name: "삭제" }).click();
  await page.getByRole("alertdialog", { name: "프로젝트 삭제 확인" }).getByRole("button", { name: "삭제 확인" }).click();
  await expect(item(page, title)).toHaveCount(0);
  expect(seen).toEqual([`DELETE /api/projects/${project.id}`]);
  await expect(page).not.toHaveURL(/projectId=|sceneId=/);
  expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(404);
  expect((await request.get(`/api/scenes/${scene.id}`)).status()).toBe(404);

  await other.reload();
  await expect(other.getByRole("alert").filter({ hasText: "NOT_FOUND" })).toContainText("삭제되었거나 존재하지 않습니다");
  await expect(other.getByRole("button", { name: /Doomed/ })).toHaveCount(0);
});

test("an active generation blocks deletion and the project stays", async ({ page, request }) => {
  const title = `Busy ${Date.now()}`;
  const project = await newProject(request, title);
  const scene = (await (await request.post("/api/scenes", { data: { projectId: project.id, content: { prompt: "Busy", camera: "", size: { width: 1024, height: 1024 }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] } } })).json()).data;
  const preview = (await (await request.post("/api/generations/preview", { data: { sceneId: scene.id, adapterId: "mock-reference", outputCount: 1, seed: 3 } })).json()).data;
  const run = (await (await request.post("/api/generations", { data: { previewId: preview.id, previewHash: preview.hash, idempotencyKey: crypto.randomUUID(), acceptUnknownCost: false, maxEstimatedCostMicros: 0 } })).json()).data;
  await page.goto("/projects");
  await item(page, title).getByRole("button", { name: "삭제" }).click();
  await page.getByRole("alertdialog", { name: "프로젝트 삭제 확인" }).getByRole("button", { name: "삭제 확인" }).click();
  const status = (await (await request.get(`/api/generations/${run.id}`)).json()).data.run.status;
  if (["succeeded", "failed"].includes(status)) test.skip(true, "the worker finished the mock run before the delete could race it");
  await expect(page.getByRole("alertdialog", { name: "프로젝트 삭제 확인" }).getByRole("alert")).toContainText("CONFLICT");
  expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(200);
  await expect.poll(async () => (await (await request.get(`/api/generations/${run.id}`)).json()).data.run.status, { timeout: 60_000 }).toBe("succeeded");
});
