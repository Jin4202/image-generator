// T16 settings screen on the real production stack (scripts/e2e-stack.ts sets env GENERATION_PROVIDER=mock and a sentinel
// FAL_KEY, so env precedence is what this stack shows). No fal request is made: saving never contacts fal.
import { expect, test } from "@playwright/test";

const ENV_SENTINEL = "e2e-sentinel-fal-key-never-in-client"; // same literal as scripts/e2e-stack.ts
const FILE_KEY = "t16-e2e-file-key:only-in-the-put-body";

test("key is typed once, sent only in the PUT body, cleared, never read back or kept in the browser", async ({ page, request }) => {
  const scripts = new Set<string>(); const bodies: string[] = [];
  page.on("response", r => { if (/\/_next\/static\/.+\.js/.test(r.url())) scripts.add(r.url()); });
  page.on("request", r => { const body = r.postData(); if (body) bodies.push(`${r.method()} ${new URL(r.url()).pathname} ${body}`); });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.getByText("환경변수 FAL_KEY가 적용 중입니다")).toBeVisible();
  await expect(page.getByText("환경변수 GENERATION_PROVIDER가 모드를 정합니다")).toBeVisible();
  await expect(page.getByText("설정됨 · 환경변수 FAL_KEY")).toBeVisible();

  const key = page.getByLabel("fal API 키");
  await expect(key).toHaveAttribute("type", "password");
  await page.getByLabel("fal (실제 생성, 유료)").check();
  await key.fill(FILE_KEY);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "저장했습니다" })).toContainText("유효한지는 확인하지 않았습니다");
  await expect(page.getByLabel("fal API 키")).toHaveValue("");
  await expect(page.getByText("저장된 모드").locator("xpath=following-sibling::dd[1]")).toContainText("fal");

  // Env mode and key win, so the running mock server needs no restart and stays usable.
  const view = await (await request.get("/api/settings/fal")).json();
  expect(view.data).toEqual({ configured: true, source: "env", savedMode: "fal", modeSource: "env", serverMode: "mock", restartRequired: false });
  expect((await (await request.get("/api/models")).json()).data[0]).toMatchObject({ available: true });

  expect(bodies.filter(b => b.includes(FILE_KEY))).toEqual([expect.stringMatching(/^PUT \/api\/settings\/fal /)]);
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
  expect(stored).not.toContain(FILE_KEY);
  expect((await page.context().cookies()).map(c => c.value).join("")).not.toContain(FILE_KEY);
  await page.reload();
  await expect(page.getByLabel("fal API 키")).toHaveValue("");
  expect(await page.content()).not.toContain(FILE_KEY);

  for (const path of ["/api/settings/fal", "/api/health", "/api/models", "/api/projects"]) {
    const text = await (await request.get(path)).text();
    expect(text, path).not.toContain(FILE_KEY); expect(text, path).not.toContain(ENV_SENTINEL);
  }
  expect(scripts.size).toBeGreaterThan(0);
  for (const url of scripts) {
    const body = await (await request.get(url)).text();
    expect(body, url).not.toContain(FILE_KEY); expect(body, url).not.toContain(ENV_SENTINEL);
  }

  // Delete restores mock in the file; the env key is untouched and still reported.
  await page.getByRole("button", { name: "저장된 키 삭제" }).click();
  await expect(page.getByRole("status").filter({ hasText: "삭제" })).toBeVisible();
  expect((await (await request.get("/api/settings/fal")).json()).data).toMatchObject({ savedMode: "mock", source: "env", restartRequired: false });
});

test("an active generation blocks settings changes with a visible conflict", async ({ page, request }) => {
  const project = (await (await request.post("/api/projects", { data: { title: "T16 active", budgetMicros: null } })).json()).data;
  const scene = (await (await request.post("/api/scenes", { data: { projectId: project.id, content: { prompt: "Active", camera: "", size: { width: 1024, height: 1024 }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] } } })).json()).data;
  const preview = (await (await request.post("/api/generations/preview", { data: { sceneId: scene.id, adapterId: "mock-reference", outputCount: 1, seed: 7 } })).json()).data;
  expect(preview?.id, "preview").toBeTruthy();
  const run = await request.post("/api/generations", { data: { previewId: preview.id, previewHash: preview.hash, idempotencyKey: crypto.randomUUID(), acceptUnknownCost: false, maxEstimatedCostMicros: 0 } });
  expect(run.status()).toBe(200);
  const runId = (await run.json()).data.id;

  await page.goto("/settings");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const active = await (await request.get(`/api/generations/${runId}`)).json();
  if (["succeeded", "failed"].includes(active.data.run.status)) test.skip(true, "the worker finished the mock run before the change could race it");
  await expect(page.getByRole("region", { name: "fal 연결" }).getByRole("alert")).toContainText("CONFLICT");
  await expect.poll(async () => (await (await request.get(`/api/generations/${runId}`)).json()).data.run.status, { timeout: 60_000 }).toBe("succeeded");
});
