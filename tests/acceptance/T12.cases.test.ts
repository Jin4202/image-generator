// T12 wiring acceptance: real route handlers through the wired container + a real worker child process (tsx), on an
// isolated, migrated temp APP_DATA_DIR. Mock provider only — no live fal call; mock output is a 1×1 fixture, not quality.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as C from "../../src/contracts";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { MOCK_PNG_BASE64, MockAdapter } from "../../src/infrastructure/models/mock";
import { getDependencies, resetDependencies } from "../../src/server/container";
import { createDependencies } from "../../src/server/create-dependencies";
import { loadConfig } from "../../src/server/config";

const KEY = "t12-sentinel-fal-key";
const base = "http://127.0.0.1:3000";
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
let root: string; const saved: Record<string, string | undefined> = {}; const workers: ChildProcess[] = [];
const setEnv = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t12-")); setEnv({ APP_DATA_DIR: root, GENERATION_PROVIDER: "mock", FAL_KEY: KEY }); });
afterEach(async () => {
  for (const w of workers.splice(0)) if (w.exitCode === null) { w.kill("SIGKILL"); await new Promise(r => w.once("exit", r)); }
  resetDependencies();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

function startWorker(env: Record<string, string> = {}) {
  const child = spawn(tsx, ["src/worker/main.ts"], { env: { ...process.env, APP_DATA_DIR: root, GENERATION_PROVIDER: "mock", FAL_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout!.on("data", d => { output += d; }); child.stderr!.on("data", d => { output += d; });
  workers.push(child);
  return { child, output: () => output, stop: () => new Promise<number | null>(resolve => { child.once("exit", code => resolve(code)); child.kill("SIGTERM"); }), exited: () => new Promise<number | null>(resolve => child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", code => resolve(code))) };
}
async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await probe(); if (value !== undefined) return value; if (Date.now() > deadline) throw new Error("timed out"); await new Promise(r => setTimeout(r, 250)); }
}
const json = (body: unknown, method = "POST") => new Request(base, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function data<T = any>(response: Response | Promise<Response>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await response; const body = await r.json();
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body.data;
}
const routes = async () => ({
  projects: await import("../../src/app/api/projects/route"),
  workspace: await import("../../src/app/api/projects/[id]/workspace/route"),
  upload: await import("../../src/app/api/media/upload/route"),
  media: await import("../../src/app/api/media/[id]/route"),
  styles: await import("../../src/app/api/styles/route"),
  styleApprove: await import("../../src/app/api/styles/[id]/approve/route"),
  assets: await import("../../src/app/api/assets/route"),
  assetApprove: await import("../../src/app/api/assets/[id]/approve/route"),
  scenes: await import("../../src/app/api/scenes/route"),
  preview: await import("../../src/app/api/generations/preview/route"),
  generations: await import("../../src/app/api/generations/route"),
  generation: await import("../../src/app/api/generations/[id]/route"),
  resolve: await import("../../src/app/api/generations/[id]/resolve/route"),
  review: await import("../../src/app/api/candidates/[id]/review/route"),
  refine: await import("../../src/app/api/candidates/[id]/refine/route"),
  effects: await import("../../src/app/api/candidates/[id]/effects/route"),
  exports: await import("../../src/app/api/exports/route"),
  manifest: await import("../../src/app/api/exports/[id]/manifest/route"),
  health: await import("../../src/app/api/health/route"),
  models: await import("../../src/app/api/models/route"),
});
type Routes = Awaited<ReturnType<typeof routes>>;
async function submitAndWait(r: Routes, preview: C.Preview, key: string) {
  const run = await data<C.Run>(r.generations.POST(json({ previewId: preview.id, previewHash: preview.hash, idempotencyKey: key, acceptUnknownCost: false, maxEstimatedCostMicros: 0 })));
  return waitFor(async () => { const view = await data<{ run: C.Run; candidates: C.Candidate[] }>(r.generation.GET(new Request(base), ctx(run.id))); return view.run.status === "succeeded" ? view : undefined; });
}

describe("full mock flow over the wired API with a separate worker process", () => {
  it("generates, reviews, refines, exports, and restores lineage after worker and server restarts", { timeout: 180_000 }, async () => {
    migrateDatabase(join(root, "studio.sqlite"));
    const r = await routes();
    const worker = startWorker();
    const project = await data<C.Project>(r.projects.POST(json({ title: "Handoff flow" })));
    const form = new FormData(); form.append("file", new Blob([Buffer.from(MOCK_PNG_BASE64, "base64")], { type: "image/png" }), "ref.png"); form.append("projectId", project.id);
    const media = await data<C.Media>(r.upload.POST(new Request(base, { method: "POST", body: form })));
    const spec = { linework: "ink", shading: "cel", palette: "teal", anatomy: "", rendering: "", lighting: "", effectsLanguage: "", positive: "anime", negative: "" };
    const style = await data<C.Style>(r.styleApprove.POST(json({}), ctx((await data<C.Style>(r.styles.POST(json({ projectId: project.id, logicalId: crypto.randomUUID(), specification: spec, referenceIds: [media.id] })))).id)));
    const asset = await data<C.Asset>(r.assetApprove.POST(json({}), ctx((await data<C.Asset>(r.assets.POST(json({ projectId: project.id, logicalId: crypto.randomUUID(), name: "Kaze", kind: "character", invariants: "scar", variants: "", slots: [{ slot: "front", mediaId: media.id }] })))).id)));
    const scene = await data<C.Scene>(r.scenes.POST(json({ projectId: project.id, content: { prompt: "Wind duel", camera: "", size: { width: 1024, height: 1024 }, references: [{ mediaId: media.id, role: "character", note: "" }], styleVersionId: style.id, assetVersionIds: [asset.id], boxes: [] } })));
    const preview = await data<C.Preview>(r.preview.POST(json({ sceneId: scene.id, adapterId: "mock-reference" })));
    const original = await submitAndWait(r, preview, crypto.randomUUID());
    expect(original.candidates).toHaveLength(1);
    const parent = original.candidates[0];
    await data(r.review.POST(json({ identity: 4, style: 4, composition: 4, anatomy: 3, preservation: null, approved: true, notes: "" }), ctx(parent.id)));
    const refinePreview = await data<C.Preview>(r.refine.POST(json({ sceneId: scene.id, adapterId: "mock-reference", outputCount: 1, seed: null, edit: { instruction: "sharper blade", preservation: "face", maskMediaId: null } }), ctx(parent.id)));
    const child = (await submitAndWait(r, refinePreview, crypto.randomUUID())).candidates[0];
    expect(child.parentCandidateId).toBe(parent.id);
    await data(r.effects.PUT(json({ expectedRevision: 0, layers: [], brightness: 1.1, contrast: 1, saturation: 1, blur: 0 }, "PUT"), ctx(child.id)));
    const exported = await data<C.ExportRecord>(r.exports.POST(json({ candidateId: child.id })));
    const manifestText = await (await r.manifest.GET(new Request(base), ctx(exported.id))).text();
    expect(C.Manifest.parse(JSON.parse(manifestText)).candidateId).toBe(child.id);
    const workspaceText = await (await r.workspace.GET(new Request(base), ctx(project.id))).text();
    for (const text of [manifestText, workspaceText]) { expect(text).not.toContain(KEY); expect(text).not.toContain(root); }

    expect(await worker.stop()).toBe(0);
    expect(worker.output()).toContain("lease released");
    resetDependencies(); // server restart: everything below is reopened from disk
    const ws = await data<C.Workspace>(r.workspace.GET(new Request(base), ctx(project.id)));
    const restoredChild = ws.candidates.find(c => c.id === child.id)!;
    expect(restoredChild.parentCandidateId).toBe(parent.id);
    expect(ws.runs.find(run => run.id === restoredChild.runId)?.snapshot.edit?.instruction).toBe("sharper blade");
    expect(ws.runs.find(run => run.id === original.run.id)?.snapshot.style?.version).toBe(1);
    expect(ws.exports.map(e => e.id)).toEqual([exported.id]);
    expect(ws.reviews.map(rv => rv.candidateId)).toEqual([parent.id]);
    expect((await r.media.GET(new Request(base), ctx(exported.pngMediaId))).status).toBe(200);
    expect(getDependencies().repo.acquireLease("after-restart", new Date().toISOString(), new Date(Date.now() + 1000).toISOString())).toBe(true);
  });
});

describe("restart recovery across processes", () => {
  it("marks an interrupted submit unknown without resubmitting; an attached request resumes in a fresh worker", { timeout: 120_000 }, async () => {
    migrateDatabase(join(root, "studio.sqlite"));
    const r = await routes();
    const project = await data<C.Project>(r.projects.POST(json({ title: "Crash" })));
    const scene = await data<C.Scene>(r.scenes.POST(json({ projectId: project.id, content: { prompt: "Rain", camera: "", size: { width: 512, height: 512 }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] } })));
    const preview = await data<C.Preview>(r.preview.POST(json({ sceneId: scene.id, adapterId: "mock-reference" })));
    const run = await data<C.Run>(r.generations.POST(json({ previewId: preview.id, previewHash: preview.hash, idempotencyKey: crypto.randomUUID(), acceptUnknownCost: false, maxEstimatedCostMicros: 0 })));
    // Simulate a worker that crashed after committing the submit intent but before recording the provider response.
    const repo = getDependencies().repo; repo.replace("runs", { ...run, revision: 1, status: "submitting" }, 0);
    const first = startWorker();
    const unknown = await waitFor(async () => { const view = await data<{ run: C.Run }>(r.generation.GET(new Request(base), ctx(run.id))); return view.run.status === "submission_unknown" ? view.run : undefined; });
    expect(unknown).toMatchObject({ providerRequestId: null, errorCode: "SUBMISSION_INTERRUPTED" });
    expect(await first.stop()).toBe(0);
    const { requestId } = await new MockAdapter().submit(preview.compiled, []);
    await data(r.resolve.POST(json({ action: "attach", providerRequestId: requestId }), ctx(run.id)));
    startWorker();
    const done = await waitFor(async () => { const view = await data<{ run: C.Run; candidates: C.Candidate[] }>(r.generation.GET(new Request(base), ctx(run.id))); return view.run.status === "succeeded" ? view : undefined; });
    expect(done.candidates).toHaveLength(1); expect(done.run.providerRequestId).toBe(requestId);
  });
});

describe("startup and readiness", () => {
  it("worker refuses an unmigrated database with a fix hint and no path", { timeout: 60_000 }, async () => {
    const worker = startWorker();
    expect(await worker.exited()).toBe(1);
    expect(worker.output()).toContain("db:migrate"); expect(worker.output()).not.toContain(root);
  });
  it("health reports readiness only after migration and never exposes the key", async () => {
    const { health, models } = await routes();
    const before = await health.GET(); expect(before.status).toBe(503); expect(await before.text()).not.toContain(root);
    migrateDatabase(join(root, "studio.sqlite"));
    expect(await data(health.GET())).toMatchObject({ status: "ok", stage: "product", persistence: "ready", provider: "mock", liveGeneration: false });
    setEnv({ GENERATION_PROVIDER: "fal" });
    const fal = await health.GET(); const text = await fal.text();
    expect(JSON.parse(text).data).toMatchObject({ provider: "fal", liveGeneration: true }); expect(text).not.toContain(KEY);
    const modelsText = await (await models.GET()).text();
    expect(JSON.parse(modelsText).data.filter((m: C.ModelInfo) => m.available).map((m: C.ModelInfo) => m.id)).toEqual(["mock-reference", "fal-flux2-edit", "fal-flux2-text"]);
    expect(modelsText).not.toContain(KEY);
  });
  it("factory wires mock always and fal adapters only in fal mode with a key", () => {
    migrateDatabase(join(root, "studio.sqlite"));
    const mock = createDependencies(loadConfig({ APP_DATA_DIR: root, GENERATION_PROVIDER: "mock", FAL_KEY: KEY }));
    expect([...mock.adapters.keys()]).toEqual(["mock-reference"]); mock.repo.close();
    const fal = createDependencies(loadConfig({ APP_DATA_DIR: root, GENERATION_PROVIDER: "fal", FAL_KEY: KEY }));
    expect([...fal.adapters.keys()]).toEqual(["mock-reference", "fal-flux2-edit", "fal-flux2-text"]);
    expect(fal.newId()).not.toBe(fal.newId()); expect(C.Timestamp.safeParse(fal.now()).success).toBe(true); fal.repo.close();
    expect(() => loadConfig({ APP_DATA_DIR: root, GENERATION_PROVIDER: "fal" })).toThrow("FAL_KEY");
  });
});
