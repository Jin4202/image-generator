// T11 normal/error/boundary cases: plan-only experiments, slot attach rules, honest report and experiment routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../src/application/ports";
import { attachExperimentRun, createExperiment, reportExperiment } from "../../src/application/services/experiments";
import type { Compiled, Money, Run, RunStatus } from "../../src/contracts";
import { compiled as baseCompiled, ids, now, project, sceneInput, snapshot as baseSnapshot } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests inject the real T01–T11 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const createRoute = await import("../../src/app/api/experiments/route");
const reportRoute = await import("../../src/app/api/experiments/[id]/route");
const attachRoute = await import("../../src/app/api/experiments/[id]/runs/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const scenes = [ids.scene, id(20), id(21)];
const known = (micros: number): Money => ({ kind: "known", micros, currency: "USD", source: "provider", verifiedAt: now });
const ratings = (pass: boolean) => ({ identity: pass ? 4 : 2, style: 4, composition: 4, anatomy: 3, preservation: null, approved: true, notes: "" });

let w: ReturnType<typeof world>; let deps: Dependencies; let seq: number;
beforeEach(() => {
  w = world(); seq = 1000;
  const submit = vi.fn();
  deps = { ...w.deps, newId: () => id(seq++), adapters: new Map([["fal-flux2-edit", { id: "fal-flux2-edit", submit, poll: vi.fn(), download: vi.fn() }]]) };
  container.deps = deps;
  for (const sceneId of scenes.slice(1)) deps.repo.insert("scenes", { id: sceneId, projectId: ids.project, revision: 0, createdAt: now, content: structuredClone(sceneInput.content) });
});
afterEach(() => { container.deps = null; w.dispose(); });

type RunSpec = { sceneId?: string; adapterId?: Compiled["adapterId"]; seed?: number | null; numImages?: number; sceneRevision?: number; edit?: boolean; status?: RunStatus; actualCost?: Money; latencyMs?: number; projectId?: string; prompt?: string };
/** Inserts a stored preview + run directly (no provider). Returns the run. */
function insertRun(spec: RunSpec = {}): Run {
  const sceneId = spec.sceneId ?? ids.scene; const previewId = id(seq++); const runId = id(seq++); const projectId = spec.projectId ?? ids.project;
  const snapshot = { ...structuredClone(baseSnapshot), sceneId, sceneRevision: spec.sceneRevision ?? 0, scene: { ...structuredClone(baseSnapshot.scene), prompt: spec.prompt ?? baseSnapshot.scene.prompt }, ...(spec.edit ? { parentCandidateId: ids.candidate, edit: { instruction: "x", preservation: "y", maskMediaId: null } } : {}) };
  const compiled: Compiled = { ...structuredClone(baseCompiled), adapterId: spec.adapterId ?? "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", estimate: { kind: "unknown", reason: "pricing-not-configured" }, parameters: { ...baseCompiled.parameters, seed: spec.seed === undefined ? 0 : spec.seed, num_images: spec.numImages ?? 1 } };
  deps.repo.insert("previews", { id: previewId, projectId, revision: 0, createdAt: now, snapshot, compiled, hash: "a".repeat(64), expiresAt: at(900_000) });
  const run: Run = { id: runId, projectId, revision: 0, createdAt: now, previewId, idempotencyKey: id(seq++), status: spec.status ?? "succeeded", snapshot, compiled, providerRequestId: "req", actualCost: spec.actualCost ?? { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: at(spec.latencyMs ?? 1000) };
  deps.repo.insert("runs", run);
  return run;
}
function addCandidate(run: Run, index = 0) {
  const mediaId = id(seq++); const candidateId = id(seq++);
  deps.repo.insert("media", { id: mediaId, projectId: run.projectId, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: 1, relativePath: `blobs/${"b".repeat(64)}.png`, source: "generated", licenseNotes: "" });
  deps.repo.insert("candidates", { id: candidateId, projectId: run.projectId, revision: 0, createdAt: now, runId: run.id, index, mediaId, parentCandidateId: null, seed: 0 });
  return candidateId;
}
function review(candidateId: string, pass: boolean, createdAt = now) {
  deps.repo.insert("reviews", { id: id(seq++), projectId: ids.project, revision: 0, createdAt, candidateId, ratings: ratings(pass) });
}
const plan = () => createExperiment(deps, { projectId: ids.project, sceneIds: scenes, repeats: 3 });

describe("createExperiment", () => {
  it("stores only a plan with frozen scene revisions, in input order, without previews, runs or provider calls", async () => {
    const scene = deps.repo.get("scenes", id(21))!; deps.repo.replace("scenes", { ...scene, revision: 1 }, 0);
    const experiment = await plan();
    expect(experiment).toMatchObject({ projectId: ids.project, revision: 0, sceneIds: scenes, runIds: [], sceneRevisions: { [ids.scene]: 0, [id(20)]: 0, [id(21)]: 1 } });
    expect(deps.repo.get("experiments", experiment.id)).toEqual(experiment);
    expect(deps.repo.list("runs", ids.project)).toEqual([]); expect(deps.repo.list("previews", ids.project)).toEqual([]);
    expect(deps.adapters.get("fal-flux2-edit")!.submit).not.toHaveBeenCalled();
  });
  it("rejects wrong scene counts, duplicates, repeats≠3 and foreign or missing scenes", async () => {
    expect(await rejection(createExperiment(deps, { projectId: ids.project, sceneIds: [ids.scene, ids.scene, id(20)], repeats: 3 }))).toBe("VALIDATION");
    expect(await rejection(createExperiment(deps, { projectId: ids.project, sceneIds: scenes.slice(0, 2), repeats: 3 }))).toBe("VALIDATION");
    expect(await rejection(createExperiment(deps, { projectId: ids.project, sceneIds: scenes, repeats: 2 as 3 }))).toBe("VALIDATION");
    deps.repo.insert("projects", { ...project, id: id(500), projectId: id(500), title: "Other" });
    deps.repo.insert("scenes", { id: id(22), projectId: id(500), revision: 0, createdAt: now, content: structuredClone(sceneInput.content) });
    expect(await rejection(createExperiment(deps, { projectId: ids.project, sceneIds: [ids.scene, id(20), id(22)], repeats: 3 }))).toBe("NOT_FOUND");
    expect(await rejection(createExperiment(deps, { projectId: id(999), sceneIds: scenes, repeats: 3 }))).toBe("NOT_FOUND");
    expect(deps.repo.list("experiments", ids.project)).toEqual([]);
  });
});

describe("attachExperimentRun", () => {
  it("attaches one run per scene × route × seed slot; re-attaching the same run is a no-op", async () => {
    const experiment = await plan(); const run = insertRun({ status: "queued" });
    const attached = await attachExperimentRun(deps, experiment.id, run.id);
    expect(attached).toMatchObject({ runIds: [run.id], revision: 1 });
    expect(await attachExperimentRun(deps, experiment.id, run.id)).toEqual(attached);
    expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun().id))).toBe("CONFLICT");
  });
  it("fills exactly the 18 planned slots and nothing more", async () => {
    const experiment = await plan();
    for (const sceneId of scenes) for (const adapterId of ["fal-flux2-edit", "fal-flux2-text"] as const) for (const seed of [0, 1, 2]) await attachExperimentRun(deps, experiment.id, insertRun({ sceneId, adapterId, seed }).id);
    expect(deps.repo.get("experiments", experiment.id)!.runIds).toHaveLength(18);
    for (const spec of [{ seed: 0 }, { seed: 3 }, { adapterId: "mock-reference" as const }]) expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun(spec).id))).toBe("CONFLICT");
  });
  it("rejects mock, edit, wrong seed, multi-output and out-of-plan runs", async () => {
    const experiment = await plan();
    deps.repo.insert("scenes", { id: id(23), projectId: ids.project, revision: 0, createdAt: now, content: structuredClone(sceneInput.content) });
    for (const spec of [{ adapterId: "mock-reference" as const }, { edit: true }, { seed: 3 }, { seed: null }, { numImages: 2 }, { sceneId: id(23) }]) {
      expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun(spec).id)), JSON.stringify(spec)).toBe("CONFLICT");
    }
    expect(deps.repo.get("experiments", experiment.id)!.runIds).toEqual([]);
  });
  it("blocks runs made after the scene changed and runs whose task intent differs within a scene", async () => {
    const experiment = await plan();
    expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun({ sceneRevision: 1 }).id))).toBe("CONFLICT");
    await attachExperimentRun(deps, experiment.id, insertRun({ adapterId: "fal-flux2-edit", seed: 0 }).id);
    expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun({ adapterId: "fal-flux2-text", seed: 0, prompt: "different intent" }).id))).toBe("CONFLICT");
    expect((await attachExperimentRun(deps, experiment.id, insertRun({ adapterId: "fal-flux2-text", seed: 0 }).id)).runIds).toHaveLength(2);
  });
  it("reports missing records and malformed ids", async () => {
    const experiment = await plan();
    deps.repo.insert("projects", { ...project, id: id(500), projectId: id(500), title: "Other" });
    expect(await rejection(attachExperimentRun(deps, experiment.id, insertRun({ projectId: id(500) }).id))).toBe("NOT_FOUND");
    expect(await rejection(attachExperimentRun(deps, experiment.id, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(attachExperimentRun(deps, id(998), insertRun().id))).toBe("NOT_FOUND");
    expect(await rejection(attachExperimentRun(deps, "bad", id(1)))).toBe("VALIDATION");
  });
});

describe("reportExperiment", () => {
  it("uses each candidate's latest review and reports unknown billing honestly", async () => {
    const experiment = await plan();
    const a = insertRun({ seed: 0, latencyMs: 4000 }); const b = insertRun({ seed: 1, latencyMs: 2000 }); const c = insertRun({ seed: 2, status: "failed", latencyMs: 99_000 });
    for (const r of [a, b, c]) await attachExperimentRun(deps, experiment.id, r.id);
    const ca = addCandidate(a); const cb = addCandidate(b);
    review(ca, false, now); review(ca, true, at(10)); review(cb, true, now); review(cb, false, at(10));
    expect(await reportExperiment(deps, experiment.id)).toEqual({ total: 2, accepted: 1, acceptanceRate: 0.5, costPerAccepted: { kind: "unknown", reason: "incomplete-billing" }, medianLatencyMs: 3000 });
  });
  it("divides known actual cost by accepted results, never using estimates", async () => {
    const experiment = await plan();
    const runs = [insertRun({ seed: 0, actualCost: known(1_000_001), latencyMs: 1000 }), insertRun({ seed: 1, actualCost: known(2_000_000), latencyMs: 3000 }), insertRun({ seed: 2, actualCost: known(0), latencyMs: 8000 })];
    for (const r of runs) { await attachExperimentRun(deps, experiment.id, r.id); review(addCandidate(r), true); }
    const report = await reportExperiment(deps, experiment.id);
    expect(report).toMatchObject({ total: 3, accepted: 3, acceptanceRate: 1, medianLatencyMs: 3000 });
    expect(report.costPerAccepted).toMatchObject({ kind: "known", micros: 1_000_000, currency: "USD" });
  });
  it("says no-accepted-results when nothing passes, even with known costs", async () => {
    const experiment = await plan(); const run = insertRun({ actualCost: known(500) });
    await attachExperimentRun(deps, experiment.id, run.id); addCandidate(run); review(addCandidate(run, 1), false);
    expect(await reportExperiment(deps, experiment.id)).toMatchObject({ total: 2, accepted: 0, acceptanceRate: 0, costPerAccepted: { kind: "unknown", reason: "no-accepted-results" } });
    expect(await rejection(reportExperiment(deps, id(999)))).toBe("NOT_FOUND");
  });
});

describe("experiment routes", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/experiments", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) });
  it("creates, attaches and reports over HTTP with contract status codes", async () => {
    const created = await createRoute.POST(post({ projectId: ids.project, sceneIds: scenes, repeats: 3 }));
    const experiment = (await created.json()).data; expect(created.status).toBe(200);
    const run = insertRun();
    expect((await attachRoute.POST(post({ runId: run.id }), ctx(experiment.id))).status).toBe(200);
    expect((await attachRoute.POST(post({ runId: insertRun().id }), ctx(experiment.id))).status).toBe(409);
    const report = await reportRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx(experiment.id));
    expect((await report.json()).data).toMatchObject({ total: 0, acceptanceRate: null, costPerAccepted: { kind: "unknown", reason: "no-accepted-results" } });
    expect((await createRoute.POST(post({ projectId: ids.project, sceneIds: scenes, repeats: 3 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await createRoute.POST(post({ projectId: ids.project, sceneIds: scenes, repeats: 3, auto: true }))).status).toBe(400);
  });
});
