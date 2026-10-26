// T11 experiments page. Product API routes are 501 until T12 wiring, so /api/** is served by an in-memory MOCK API
// (contract-valid fixtures via page.route). UI behavior only — no storage, billing or model quality is verified here.
import { expect, test, type Page, type Route } from "@playwright/test";
import type { Experiment, ModelInfo, Scene, Workspace } from "../../src/contracts";
import { ids, now, project, sceneInput } from "../support/fixtures";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scene = (n: string, prompt: string, revision = 0): Scene => ({ id: n, projectId: ids.project, revision, createdAt: now, content: { ...structuredClone(sceneInput.content), prompt } });
const scenes = [scene(ids.scene, "Cliff duel"), scene(id(20), "Rain alley", 1), scene(id(21), "Rooftop chase")];
const models: ModelInfo[] = [
  { id: "mock-reference", provider: "mock", endpoint: "mock://fixture", available: true, mode: "mock", scope: "product", maxReferences: 4, masks: false, reason: null },
  { id: "fal-flux2-edit", provider: "fal", endpoint: "fal-ai/flux-2/edit", available: true, mode: "live", scope: "product", maxReferences: 4, masks: false, reason: null },
  { id: "fal-flux2-text", provider: "fal", endpoint: "fal-ai/flux-2", available: true, mode: "live", scope: "product", maxReferences: 0, masks: false, reason: null },
];

async function mockApi(page: Page) {
  const existing: Experiment = { id: id(40), projectId: ids.project, revision: 0, createdAt: now, sceneIds: scenes.map(s => s.id), sceneRevisions: { [ids.scene]: 0, [id(20)]: 0, [id(21)]: 0 }, runIds: [] };
  const workspace: Workspace = { project, media: [], styles: [], assets: [], scenes, runs: [], candidates: [], reviews: [], effects: [], exports: [], experiments: [existing] };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const json = (route: Route, data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  await page.route("**/api/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : null; calls.push({ method, path, body });
    if (path === "/api/models") return json(route, models);
    if (path === `/api/projects/${ids.project}/workspace`) return json(route, workspace);
    if (path === "/api/experiments" && method === "POST") { const created = { ...existing, id: id(41), sceneIds: body.sceneIds }; workspace.experiments.push(created); return json(route, created); }
    if (/^\/api\/experiments\/[^/]+$/.test(path)) return json(route, { total: 0, accepted: 0, acceptanceRate: null, costPerAccepted: { kind: "unknown", reason: "no-accepted-results" }, medianLatencyMs: null });
    return route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_IMPLEMENTED", message: "mock" } }) });
  });
  return calls;
}

test("creating a plan sends no generation request; slots, frozen revisions and honest report are shown", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto(`/experiments?projectId=${ids.project}`);
  await expect(page.getByRole("heading", { name: "실험", exact: true })).toBeVisible();
  for (const [i, s] of scenes.entries()) await page.getByLabel(`실험 장면 ${i + 1}`).selectOption(s.id);
  await page.getByRole("button", { name: "실험 계획 저장" }).click();
  await expect(page).toHaveURL(new RegExp(`experimentId=${id(41)}`));
  expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/api/experiments"]);
  expect(calls.find(c => c.path === "/api/experiments")?.body).toEqual({ projectId: ids.project, sceneIds: scenes.map(s => s.id), repeats: 3 });

  await page.goto(`/experiments?projectId=${ids.project}&experimentId=${id(40)}`);
  await expect(page.getByRole("heading", { name: "슬롯 진행 (0/18)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "생성", exact: true })).toHaveCount(18);
  await expect(page.getByText("rev 1로 수정되어")).toBeVisible();
  const rainRows = page.locator("table").nth(1).getByRole("button", { name: "생성", exact: true });
  for (const button of await rainRows.all()) await expect(button).toBeDisabled();
  await expect(page.locator("table").first().getByRole("button", { name: "생성", exact: true }).first()).toBeEnabled();
  await expect(page.getByText("알 수 없음 (승인된 결과 없음)")).toBeVisible();
  await expect(page.getByText("— (결과 없음)")).toBeVisible();
  expect(calls.filter(c => c.path.startsWith("/api/generations"))).toEqual([]);
});

test("experiments page has no horizontal overflow on mobile", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/experiments?projectId=${ids.project}&experimentId=${id(40)}`);
  await expect(page.getByRole("heading", { name: "슬롯 진행 (0/18)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
