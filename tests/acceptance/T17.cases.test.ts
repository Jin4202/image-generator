// T17: project edit (CAS) and delete (one transaction, FK-safe, active runs block, blobs kept). Real SQLite + services
// on an isolated temp APP_DATA_DIR; routes go through a container test double. No provider calls.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies, EntityKind } from "../../src/application/ports";
import { exportCandidate, saveEffects } from "../../src/application/services/effects";
import { createExperiment } from "../../src/application/services/experiments";
import { createAsset, createStyle } from "../../src/application/services/library";
import { uploadMedia } from "../../src/application/services/media";
import { createProject, deleteProject, getProject, getWorkspace, updateProject } from "../../src/application/services/projects";
import { saveReview } from "../../src/application/services/review";
import { submitRun } from "../../src/application/services/runs";
import { createScene } from "../../src/application/services/scenes";
import type { RunStatus } from "../../src/contracts";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { compiled, now, sceneInput, snapshot } from "../support/fixtures";
import { world } from "../support/world";

const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const projectRoute = await import("../../src/app/api/projects/[id]/route");
const mediaRoute = await import("../../src/app/api/media/[id]/route");
const manifestRoute = await import("../../src/app/api/exports/[id]/manifest/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = () => new Uint8Array(Buffer.from(MOCK_PNG_BASE64, "base64"));
const code = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const kinds: EntityKind[] = ["media", "styles", "assets", "scenes", "previews", "runs", "candidates", "reviews", "effects", "exports", "experiments"];
const activeStatuses: RunStatus[] = ["draft", "submitting", "queued", "running", "downloading", "download_failed", "submission_unknown"];

let w: ReturnType<typeof world>; let deps: Dependencies; let seq: number;
beforeEach(() => {
  w = world(); seq = 5000;
  deps = { ...w.deps, blobs: createLocalBlobStore(w.root), newId: () => id(seq++) }; container.deps = deps;
});
afterEach(() => { container.deps = null; w.dispose(); });

/** A project with one record of every aggregate kind (run succeeded, so nothing is active). */
async function fullProject(title: string) {
  const project = await createProject(deps, { title, budgetMicros: null });
  const media = await uploadMedia(deps, { projectId: project.id, bytes: png(), declaredMime: "image/png", licenseNotes: "shared bytes" });
  const spec = { linework: "", shading: "", palette: "", anatomy: "", rendering: "", lighting: "", effectsLanguage: "", positive: "p", negative: "" };
  await createStyle(deps, { projectId: project.id, logicalId: id(seq++), specification: spec, referenceIds: [media.id] });
  await createAsset(deps, { projectId: project.id, logicalId: id(seq++), name: "Hero", kind: "character", invariants: "", variants: "", slots: [{ slot: "front", mediaId: media.id }] });
  const scenes = [];
  for (const prompt of ["a", "b", "c"]) scenes.push(await createScene(deps, { projectId: project.id, content: { ...structuredClone(sceneInput.content), prompt } }));
  const previewId = id(seq++);
  deps.repo.insert("previews", { id: previewId, projectId: project.id, revision: 0, createdAt: now, snapshot: { ...structuredClone(snapshot), sceneId: scenes[0].id }, compiled: structuredClone(compiled), hash: "b".repeat(64), expiresAt: "2999-01-01T00:00:00.000Z" });
  const runId = id(seq++);
  deps.repo.insert("runs", { id: runId, projectId: project.id, revision: 0, createdAt: now, previewId, idempotencyKey: id(seq++), status: "succeeded", snapshot: { ...structuredClone(snapshot), sceneId: scenes[0].id }, compiled: structuredClone(compiled), providerRequestId: "seed", actualCost: { kind: "known", micros: 0, currency: "USD", source: "mock", verifiedAt: now }, errorCode: null, updatedAt: now });
  const candidateId = id(seq++);
  deps.repo.insert("candidates", { id: candidateId, projectId: project.id, revision: 0, createdAt: now, runId, index: 0, mediaId: media.id, parentCandidateId: null, seed: 1 });
  await saveReview(deps, candidateId, { identity: 4, style: 4, composition: 4, anatomy: 4, preservation: null, approved: true, notes: "" });
  await saveEffects(deps, candidateId, { expectedRevision: 0, layers: [], brightness: 1.1, contrast: 1, saturation: 1, blur: 0 });
  const exported = await exportCandidate(deps, { candidateId });
  await createExperiment(deps, { projectId: project.id, sceneIds: scenes.map(s => s.id), repeats: 3 });
  return { project: await getProject(deps, project.id), media, runId, previewId, exported };
}
/** Adds a run in `status` (with its own preview: one run per preview) to the project of `runId`'s run. */
function addRun(runId: string, status: RunStatus) {
  const run = deps.repo.get("runs", runId)!; const preview = deps.repo.get("previews", run.previewId)!;
  const previewId = id(seq++); deps.repo.insert("previews", { ...preview, id: previewId, hash: "c".repeat(64) });
  deps.repo.insert("runs", { ...run, id: id(seq++), previewId, idempotencyKey: id(seq++), status, revision: 0 });
}
const countsOf = (projectId: string) => Object.fromEntries(kinds.map(k => [k, deps.repo.list(k, projectId).length]));
const ctx = (projectId: string) => ({ params: Promise.resolve({ id: projectId }) });
const request = (method: string, body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/projects/x", { method, headers: { "content-type": "application/json", host: "127.0.0.1:3000", ...headers }, body: JSON.stringify(body) });

describe("edit", () => {
  it("updates title and budget with CAS; id/createdAt and run snapshots stay", async () => {
    const { project, runId } = await fullProject("Before");
    const run = deps.repo.get("runs", runId);
    const updated = await updateProject(deps, project.id, { expectedRevision: project.revision, title: "After", budgetMicros: 2_000_000 });
    expect(updated).toMatchObject({ id: project.id, createdAt: project.createdAt, revision: project.revision + 1, title: "After", budgetMicros: 2_000_000 });
    expect(await getProject(deps, project.id)).toEqual(updated);
    expect(deps.repo.get("runs", runId)).toEqual(run);
    expect(await code(updateProject(deps, project.id, { expectedRevision: project.revision, title: "Stale", budgetMicros: null }))).toBe("CONFLICT");
    for (const bad of [{ title: "  ", budgetMicros: null }, { title: "x".repeat(121), budgetMicros: null }, { title: "ok", budgetMicros: -1 }, { title: "ok", budgetMicros: 1.5 }])
      expect(await code(updateProject(deps, project.id, { expectedRevision: updated.revision, ...bad }))).toBe("VALIDATION");
    expect(await code(updateProject(deps, id(9999), { expectedRevision: 0, title: "x", budgetMicros: null }))).toBe("NOT_FOUND");
    expect(await getProject(deps, project.id)).toEqual(updated);
  });
  it("lowering the budget keeps past costs and applies to the next submit", async () => {
    const project = await createProject(deps, { title: "Budget", budgetMicros: 1_000 });
    const scene = await createScene(deps, { projectId: project.id, content: structuredClone(sceneInput.content) });
    const addPreview = (n: number, micros: number) => { const pid = id(700 + n); deps.repo.insert("previews", { id: pid, projectId: project.id, revision: 0, createdAt: now, snapshot: { ...structuredClone(snapshot), sceneId: scene.id }, compiled: { ...structuredClone(compiled), estimate: { kind: "known", micros, currency: "USD", source: "test", verifiedAt: now } }, hash: String(n).repeat(64), expiresAt: "2999-01-01T00:00:00.000Z" }); return { previewId: pid, previewHash: String(n).repeat(64), idempotencyKey: id(800 + n), acceptUnknownCost: false, maxEstimatedCostMicros: micros }; };
    const first = await submitRun(deps, addPreview(1, 600));
    deps.repo.replace("runs", { ...first, status: "failed", revision: 1 }, 0);
    const lowered = await updateProject(deps, project.id, { expectedRevision: 0, title: "Budget", budgetMicros: 500 });
    expect(deps.repo.get("runs", first.id)).toMatchObject({ status: "failed" }); // nothing cancelled or rewritten
    expect(await code(submitRun(deps, addPreview(2, 100)))).toBe("BUDGET_EXCEEDED"); // 600 already reserved > 500
    await updateProject(deps, project.id, { expectedRevision: lowered.revision, title: "Budget", budgetMicros: 700 });
    expect((await submitRun(deps, addPreview(3, 100))).status).toBe("draft");
  });
});

describe("delete", () => {
  it("removes every record of the project in one go; other projects and shared blobs survive", async () => {
    const a = await fullProject("A"); const b = await fullProject("B");
    expect(a.media.relativePath).toBe(b.media.relativePath); // same bytes → one content-addressed blob
    const bBefore = await getWorkspace(deps, b.project.id);
    expect(Object.values(countsOf(a.project.id)).every(n => n > 0)).toBe(true);
    expect(await deleteProject(deps, a.project.id, { expectedRevision: a.project.revision })).toEqual({ id: a.project.id, deleted: true });
    expect(await code(getProject(deps, a.project.id))).toBe("NOT_FOUND");
    expect(await code(getWorkspace(deps, a.project.id))).toBe("NOT_FOUND");
    expect(countsOf(a.project.id)).toEqual(Object.fromEntries(kinds.map(k => [k, 0])));
    expect(deps.repo.get("previews", a.previewId)).toBeNull();
    expect((await mediaRoute.GET(new Request("http://127.0.0.1:3000"), ctx(a.media.id))).status).toBe(404);
    expect((await manifestRoute.GET(new Request("http://127.0.0.1:3000"), ctx(a.exported.id))).status).toBe(404);
    expect(await getWorkspace(deps, b.project.id)).toEqual(bBefore);
    expect(existsSync(join(w.root, b.media.relativePath))).toBe(true);
    expect((await mediaRoute.GET(new Request("http://127.0.0.1:3000"), ctx(b.media.id))).status).toBe(200);
  });
  it.each(activeStatuses)("a %s run of the project blocks deletion; nothing is removed", async status => {
    const { project, runId } = await fullProject("Busy");
    addRun(runId, status);
    const before = countsOf(project.id);
    expect(await code(deleteProject(deps, project.id, { expectedRevision: project.revision }))).toBe("CONFLICT");
    expect(countsOf(project.id)).toEqual(before);
  });
  it("another project's active run does not block; stale revision and missing project are refused", async () => {
    const a = await fullProject("A"); const b = await fullProject("B");
    addRun(b.runId, "submission_unknown");
    expect(await code(deleteProject(deps, a.project.id, { expectedRevision: a.project.revision + 1 }))).toBe("CONFLICT");
    expect(await code(deleteProject(deps, id(9999), { expectedRevision: 0 }))).toBe("NOT_FOUND");
    expect(await code(deleteProject(deps, "nope", { expectedRevision: 0 }))).toBe("VALIDATION");
    expect((await deleteProject(deps, a.project.id, { expectedRevision: a.project.revision })).deleted).toBe(true);
  });
  it("a failure inside the delete transaction rolls everything back (no partial delete)", async () => {
    const { project } = await fullProject("Atomic");
    const before = countsOf(project.id);
    expect(() => deps.repo.transaction(tx => { tx.deleteProject(project.id); throw new Error("boom after delete"); })).toThrow("boom");
    expect(countsOf(project.id)).toEqual(before);
    expect(deps.repo.get("projects", project.id)).not.toBeNull();
  });
  it("submit and delete serialize: run first blocks the delete, delete first makes the submit NOT_FOUND, never an orphan run", async () => {
    const project = await createProject(deps, { title: "Race", budgetMicros: null });
    const scene = await createScene(deps, { projectId: project.id, content: structuredClone(sceneInput.content) });
    const preview = (n: number) => { const pid = id(900 + n); deps.repo.insert("previews", { id: pid, projectId: project.id, revision: 0, createdAt: now, snapshot: { ...structuredClone(snapshot), sceneId: scene.id }, compiled: structuredClone(compiled), hash: String(n).repeat(64), expiresAt: "2999-01-01T00:00:00.000Z" }); return { previewId: pid, previewHash: String(n).repeat(64), idempotencyKey: id(950 + n), acceptUnknownCost: false, maxEstimatedCostMicros: 0 }; };
    const first = preview(1);
    const [run, refused] = await Promise.allSettled([submitRun(deps, first), deleteProject(deps, project.id, { expectedRevision: 0 })]);
    expect(run.status).toBe("fulfilled"); expect(refused.status === "rejected" && (refused.reason as { code: string }).code).toBe("CONFLICT");
    const r = deps.repo.get("runs", (run as PromiseFulfilledResult<{ id: string }>).value.id)!; deps.repo.replace("runs", { ...r, status: "failed", revision: 1 }, 0);
    const second = preview(2);
    const [deleted, late] = await Promise.allSettled([deleteProject(deps, project.id, { expectedRevision: 0 }), submitRun(deps, second)]);
    expect(deleted.status).toBe("fulfilled"); expect(late.status === "rejected" && (late.reason as { code: string }).code).toBe("NOT_FOUND");
    const projects = new Set(deps.repo.list("projects").map(p => p.id));
    expect(deps.repo.list("runs").filter(run => !projects.has(run.projectId))).toEqual([]);
  });
});

describe("routes", () => {
  it("PATCH and DELETE use the JSON envelope, CAS and the same-origin guard", async () => {
    const { project } = await fullProject("Route");
    const patched = await projectRoute.PATCH(request("PATCH", { expectedRevision: project.revision, title: "Renamed", budgetMicros: null }), ctx(project.id));
    expect(patched.status).toBe(200); const body = await patched.json(); expect(body.data).toMatchObject({ title: "Renamed", revision: project.revision + 1 });
    expect((await projectRoute.PATCH(request("PATCH", { expectedRevision: 0, title: "x" }), ctx(project.id))).status).toBe(400);
    expect((await projectRoute.DELETE(request("DELETE", { expectedRevision: body.data.revision }, { origin: "https://evil.example" }), ctx(project.id))).status).toBe(403);
    expect((await projectRoute.DELETE(request("DELETE", { expectedRevision: project.revision }), ctx(project.id))).status).toBe(409);
    const removed = await projectRoute.DELETE(request("DELETE", { expectedRevision: body.data.revision }), ctx(project.id));
    expect(removed.status).toBe(200); expect((await removed.json()).data).toEqual({ id: project.id, deleted: true });
    expect((await projectRoute.GET(new Request("http://127.0.0.1:3000"), ctx(project.id))).status).toBe(404);
  });
});
