// T10 MOCK API for browser tests: in-memory, contract-valid fixtures served through page.route (no real storage or models).
import type { Page, Route } from "@playwright/test";
import type { Candidate, Compiled, Effects, Media, ModelInfo, Preview, Project, Run, RunStatus, Scene, Workspace } from "../../src/contracts";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { compiled as baseCompiled, ids, now, project as baseProject, sceneInput, snapshot } from "../support/fixtures";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = Buffer.from(MOCK_PNG_BASE64, "base64");
const media: Media = { id: ids.media, projectId: ids.project, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: png.length, relativePath: `blobs/${"b".repeat(64)}.png`, source: "upload", licenseNotes: "" };
const scene: Scene = { id: ids.scene, projectId: ids.project, revision: 0, createdAt: now, content: { ...structuredClone(sceneInput.content), prompt: "Wind duel on a cliff", references: [{ mediaId: ids.media, role: "character", note: "front" }] } };
const unknownPrice: Compiled["estimate"] = { kind: "unknown", reason: "pricing-not-configured" };
const models: ModelInfo[] = [
  { id: "mock-reference", provider: "mock", endpoint: "mock://fixture", available: true, mode: "mock", scope: "product", maxReferences: 4, masks: false, reason: null },
  { id: "fal-flux2-edit", provider: "fal", endpoint: "fal-ai/flux-2/edit", available: true, mode: "live", scope: "product", maxReferences: 4, masks: false, reason: null },
  { id: "fal-flux2-text", provider: "fal", endpoint: "fal-ai/flux-2", available: false, mode: "live", scope: "product", maxReferences: 0, masks: false, reason: "NOT_CONFIGURED" },
];
const parentCandidate: Candidate = { id: ids.candidate, projectId: ids.project, revision: 0, createdAt: now, runId: ids.run, index: 0, mediaId: ids.media, parentCandidateId: null, seed: 1 };
const editRunId = id(70); export const childId = id(71);
const editRun: Run = { id: editRunId, projectId: ids.project, revision: 3, createdAt: now, previewId: id(72), idempotencyKey: id(73), status: "succeeded", snapshot: { ...structuredClone(snapshot), parentCandidateId: ids.candidate, edit: { instruction: "fix blade", preservation: "face", maskMediaId: null } }, compiled: structuredClone(baseCompiled), providerRequestId: "mock", actualCost: { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: "2026-10-26T00:00:09.000Z" };
const childCandidate: Candidate = { ...parentCandidate, id: childId, runId: editRunId, parentCandidateId: ids.candidate };

type Options = { budgetMicros?: number | null; projectsStatus?: number; submitStatus?: number; runStatuses?: RunStatus[] };
/** In-memory MOCK API. Records calls so tests can assert what the UI sent (or did not send). */
export async function mockApi(page: Page, options: Options = {}) {
  const project: Project = { ...baseProject, budgetMicros: options.budgetMicros ?? null };
  const firstRun: Run = { id: ids.run, projectId: ids.project, revision: 2, createdAt: now, previewId: ids.preview, idempotencyKey: id(9), status: "succeeded", snapshot: structuredClone(snapshot), compiled: structuredClone(baseCompiled), providerRequestId: "mock", actualCost: { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: "2026-10-26T00:00:05.000Z" };
  const state = {
    workspace: { project, media: [media], styles: [], assets: [], scenes: [scene], runs: [firstRun, editRun], candidates: [parentCandidate, childCandidate], reviews: [], effects: [], exports: [], experiments: [] } as Workspace,
    calls: [] as { method: string; path: string; body: unknown }[],
    runStatuses: [...(options.runStatuses ?? ["queued", "running", "succeeded"])],
    effects: null as Effects | null,
  };
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status < 400 ? { data } : data) });
  const fail = (route: Route, status: number, code: string) => json(route, { error: { code, message: `mock ${code}` } }, status);
  await page.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    const body = request.postData() && request.headers()["content-type"]?.includes("json") ? JSON.parse(request.postData()!) : null;
    state.calls.push({ method, path, body });
    if (path.startsWith("/api/media/")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (path === "/api/models") return json(route, models);
    if (path === "/api/projects" && method === "GET") return options.projectsStatus ? fail(route, options.projectsStatus, "NOT_IMPLEMENTED") : json(route, [project]);
    if (path === "/api/projects" && method === "POST") { const created: Project = { ...project, id: id(500), projectId: id(500), title: body.title.trim(), budgetMicros: body.budgetMicros }; return json(route, created); }
    if (path === `/api/projects/${ids.project}/workspace`) return json(route, state.workspace);
    if (path === "/api/generations/preview") {
      const fal = body.adapterId !== "mock-reference";
      const preview: Preview = { id: id(600 + state.calls.length), projectId: ids.project, revision: 0, createdAt: now, snapshot: structuredClone(snapshot), hash: "c".repeat(64), expiresAt: new Date(Date.now() + 900_000).toISOString(),
        compiled: { ...structuredClone(baseCompiled), adapterId: body.adapterId, endpoint: fal ? "fal-ai/flux-2/edit" : "mock://fixture", references: scene.content.references, warnings: ["SOFT_LAYOUT"], estimate: fal ? unknownPrice : baseCompiled.estimate, parameters: { ...baseCompiled.parameters, seed: body.seed, num_images: body.outputCount } } };
      return json(route, preview);
    }
    if (path === "/api/generations" && method === "POST") {
      if (options.submitStatus) return fail(route, options.submitStatus, options.submitStatus === 501 ? "NOT_IMPLEMENTED" : "COST_UNKNOWN");
      return json(route, { ...firstRun, id: id(800), status: "draft", previewId: body.previewId, idempotencyKey: body.idempotencyKey });
    }
    const runMatch = /^\/api\/generations\/([^/]+)$/.exec(path);
    if (runMatch && method === "GET") {
      const status = state.runStatuses.length > 1 ? state.runStatuses.shift()! : state.runStatuses[0];
      return json(route, { run: { ...firstRun, id: runMatch[1], status }, candidates: status === "succeeded" ? [{ ...parentCandidate, id: id(801), runId: runMatch[1] }] : [] });
    }
    const candidateMatch = /^\/api\/candidates\/([^/]+)(\/.*)?$/.exec(path);
    if (candidateMatch) {
      const candidate = [parentCandidate, childCandidate].find(c => c.id === candidateMatch[1]);
      if (!candidate) return fail(route, 404, "NOT_FOUND");
      if (!candidateMatch[2]) return json(route, { candidate, reviews: [] });
      if (candidateMatch[2] === "/review") return json(route, { id: id(900), projectId: ids.project, revision: 0, createdAt: now, candidateId: candidate.id, ratings: body });
      if (candidateMatch[2] === "/effects" && method === "GET") return json(route, state.effects);
      if (candidateMatch[2] === "/effects" && method === "PUT") { state.effects = { id: id(950), projectId: ids.project, revision: state.effects ? state.effects.revision + 1 : 0, createdAt: now, candidateId: candidate.id, content: body }; return json(route, state.effects); }
    }
    if (path === "/api/exports") return json(route, { id: id(960), projectId: ids.project, revision: 0, createdAt: now, candidateId: body.candidateId, pngMediaId: ids.media, manifestPath: `blobs/${"d".repeat(64)}.json`, manifestVersion: 1 });
    return fail(route, 501, "NOT_IMPLEMENTED");
  });
  return state;
}
