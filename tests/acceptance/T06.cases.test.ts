// T06 normal/error/boundary cases: submit policy, worker steps, recovery paths, runWorker loop and generation routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies, ModelAdapter, ProviderOutput, ProviderStatus } from "../../src/application/ports";
import { getRun, resolveRun, retryDownload, submitRun, tickWorker } from "../../src/application/services/runs";
import type { Compiled, Money, Preview } from "../../src/contracts";
import { SubmissionError } from "../../src/domain/errors";
import { MOCK_PNG_BASE64, MockAdapter } from "../../src/infrastructure/models/mock";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { runWorker } from "../../src/worker/runner";
import { compiled as baseCompiled, ids, now, project, snapshot } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests inject the real T01–T06 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const generationsRoute = await import("../../src/app/api/generations/route");
const generationRoute = await import("../../src/app/api/generations/[id]/route");
const resolveRoute = await import("../../src/app/api/generations/[id]/resolve/route");
const retryRoute = await import("../../src/app/api/generations/[id]/retry-download/route");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = () => new Uint8Array(Buffer.from(MOCK_PNG_BASE64, "base64"));
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const known = (micros: number): Money => ({ kind: "known", micros, currency: "USD", source: "test", verifiedAt: now });
const unknown: Money = { kind: "unknown", reason: "pricing-not-configured" };

/** Scripted adapter that records every provider call. */
class FakeAdapter implements ModelAdapter {
  calls = { submit: 0, poll: 0, download: 0 };
  submitImpl: () => Promise<{ requestId: string }> = async () => ({ requestId: "req-1" });
  pollImpl: () => Promise<ProviderStatus> = async () => ({ status: "completed" });
  downloadImpl: () => Promise<ProviderOutput[]> = async () => [{ bytes: png(), mime: "image/png", seed: 3 }];
  constructor(readonly id: Compiled["adapterId"]) {}
  submit() { this.calls.submit++; return this.submitImpl(); }
  poll() { this.calls.poll++; return this.pollImpl(); }
  download() { this.calls.download++; return this.downloadImpl(); }
}

let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string; let seq: number;
const useAdapters = (...adapters: ModelAdapter[]) => { deps = { ...deps, adapters: new Map(adapters.map(a => [a.id, a])) }; container.deps = deps; };
beforeEach(() => {
  w = world(); clock = now; seq = 1000;
  deps = { ...w.deps, blobs: createLocalBlobStore(w.root), now: () => clock, newId: () => id(seq++) }; container.deps = deps;
});
afterEach(() => { vi.useRealTimers(); container.deps = null; w.dispose(); });

const addPreview = (n: number, compiled: Partial<Compiled> = {}, patch: Partial<Preview> = {}): Preview => {
  const preview: Preview = { id: id(n), projectId: ids.project, revision: 0, createdAt: now, snapshot: structuredClone(snapshot), compiled: { ...structuredClone(baseCompiled), ...compiled }, hash: String(n % 10).repeat(64), expiresAt: at(900_000), ...patch };
  deps.repo.insert("previews", preview); return preview;
};
const submit = (preview: Preview, patch: Record<string, unknown> = {}) => submitRun(deps, { previewId: preview.id, previewHash: preview.hash, idempotencyKey: id(preview.id === ids.preview ? 1 : Number(preview.id.slice(-4)) + 5000), acceptUnknownCost: false, maxEstimatedCostMicros: 0, ...patch });
const status = (runId: string) => deps.repo.get("runs", runId)!;
const terminate = (runId: string) => { const run = status(runId); deps.repo.replace("runs", { ...run, revision: run.revision + 1, status: "failed", errorCode: "TEST" }, run.revision); };
const insertRun = (previewId: string, patch: Record<string, unknown>) => {
  const preview = deps.repo.get("previews", previewId)!;
  const run = { id: id(seq++), projectId: ids.project, revision: 0, createdAt: now, previewId, idempotencyKey: id(seq++), status: "draft" as const, snapshot: preview.snapshot, compiled: preview.compiled, providerRequestId: null, actualCost: { kind: "unknown" as const, reason: "not-reported" }, errorCode: null, updatedAt: now, ...patch };
  deps.repo.insert("runs", run as never); return run.id;
};

describe("submitRun", () => {
  it("creates a draft run with deep-copied snapshot and never calls the provider", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    const preview = addPreview(1);
    const run = await submit(preview);
    expect(run).toMatchObject({ status: "draft", revision: 0, providerRequestId: null, errorCode: null, actualCost: { kind: "unknown", reason: "not-reported" }, previewId: preview.id, createdAt: now, updatedAt: now });
    expect(run.snapshot).toEqual(preview.snapshot); expect(run.compiled).toEqual(preview.compiled);
    expect(fake.calls).toEqual({ submit: 0, poll: 0, download: 0 });
  });
  it("replays by key or by preview, even after expiry, and rejects key reuse for another preview", async () => {
    const a = addPreview(1); const b = addPreview(2);
    const run = await submit(a);
    clock = at(3_600_000);
    expect((await submit(a)).id).toBe(run.id);
    expect((await submit(a, { idempotencyKey: id(9999) })).id).toBe(run.id);
    expect(await rejection(submit(b, { idempotencyKey: run.idempotencyKey }))).toBe("CONFLICT");
    expect(await rejection(submit(a, { previewHash: "f".repeat(64) }))).toBe("CONFLICT");
    expect(deps.repo.list("runs", ids.project)).toHaveLength(1);
  });
  it("requires a matching hash, an unexpired preview and an unchanged scene", async () => {
    const preview = addPreview(1);
    expect(await rejection(submit(preview, { previewHash: "f".repeat(64) }))).toBe("CONFLICT");
    clock = preview.expiresAt; expect(await rejection(submit(preview))).toBe("STALE_PREVIEW");
    clock = at(899_999);
    const scene = deps.repo.get("scenes", ids.scene)!; deps.repo.replace("scenes", { ...scene, revision: 1 }, 0);
    expect(await rejection(submit(preview))).toBe("STALE_PREVIEW");
    expect(await rejection(submitRun(deps, { previewId: id(77), previewHash: "a".repeat(64), idempotencyKey: id(78), acceptUnknownCost: false, maxEstimatedCostMicros: 0 }))).toBe("NOT_FOUND");
  });
  it("rejects adapters missing from the dependency map", async () => {
    useAdapters(new FakeAdapter("fal-flux2-text"));
    expect(await rejection(submit(addPreview(1)))).toBe("UNSUPPORTED");
  });
  it("allows only one active run globally until it is terminal", async () => {
    deps.repo.insert("projects", { ...project, id: id(500), projectId: id(500), title: "Other" });
    const first = await submit(addPreview(1));
    expect(await rejection(submit(addPreview(2)))).toBe("CONFLICT");
    for (const s of ["submitting", "queued", "running", "downloading", "download_failed", "submission_unknown"] as const) {
      const run = status(first.id); deps.repo.replace("runs", { ...run, revision: run.revision + 1, status: s }, run.revision);
      expect(await rejection(submit(addPreview(3 + ["submitting", "queued", "running", "downloading", "download_failed", "submission_unknown"].indexOf(s))))).toBe("CONFLICT");
    }
    terminate(first.id);
    expect((await submit(addPreview(20))).status).toBe("draft");
  });
  it("applies the known-cost consent rules, including mock zero", async () => {
    const cheap = addPreview(1, { estimate: known(500) });
    expect(await rejection(submit(cheap, { maxEstimatedCostMicros: null }))).toBe("VALIDATION");
    expect(await rejection(submit(cheap, { maxEstimatedCostMicros: 499 }))).toBe("BUDGET_EXCEEDED");
    expect((await submit(cheap, { maxEstimatedCostMicros: 500 })).status).toBe("draft");
  });
  it("requires explicit unknown-cost consent and blocks unknown prices on finite budgets", async () => {
    useAdapters(new FakeAdapter("fal-flux2-edit"));
    const p = addPreview(1, { adapterId: "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", estimate: unknown });
    expect(await rejection(submit(p, { acceptUnknownCost: false, maxEstimatedCostMicros: null }))).toBe("COST_UNKNOWN");
    expect(await rejection(submit(p, { acceptUnknownCost: true, maxEstimatedCostMicros: 0 }))).toBe("COST_UNKNOWN");
    const proj = deps.repo.get("projects", ids.project)!; deps.repo.replace("projects", { ...proj, revision: 1, budgetMicros: 1_000_000 }, 0);
    expect(await rejection(submit(p, { acceptUnknownCost: true, maxEstimatedCostMicros: null }))).toBe("COST_UNKNOWN");
    deps.repo.replace("projects", { ...proj, revision: 2, budgetMicros: null }, 1);
    expect((await submit(p, { acceptUnknownCost: true, maxEstimatedCostMicros: null })).status).toBe("draft");
  });
  it("reserves known actual cost first, then known estimates, against a finite budget", async () => {
    const proj = deps.repo.get("projects", ids.project)!; deps.repo.replace("projects", { ...proj, revision: 1, budgetMicros: 1000 }, 0);
    addPreview(1, { estimate: known(600) }); const prior = insertRun(id(1), { status: "failed" });
    expect(await rejection(submit(addPreview(2, { estimate: known(500) }), { maxEstimatedCostMicros: 500 }))).toBe("BUDGET_EXCEEDED");
    const exact = await submit(addPreview(3, { estimate: known(400) }), { maxEstimatedCostMicros: 400 });
    terminate(exact.id);
    const run = status(prior); deps.repo.replace("runs", { ...run, revision: run.revision + 1, actualCost: known(100) }, run.revision);
    expect((await submit(addPreview(4, { estimate: known(500) }), { maxEstimatedCostMicros: 500 })).status).toBe("draft");
  });
  it("blocks a finite budget when any earlier run has no known cost", async () => {
    const proj = deps.repo.get("projects", ids.project)!; deps.repo.replace("projects", { ...proj, revision: 1, budgetMicros: 1000 }, 0);
    addPreview(1, { estimate: unknown }); insertRun(id(1), { status: "failed" });
    expect(await rejection(submit(addPreview(2, { estimate: known(0) })))).toBe("COST_UNKNOWN");
  });
});

describe("tickWorker", () => {
  it("advances one step per tick and commits media + candidates atomically", async () => {
    const run = await submit(addPreview(1, { parameters: { ...baseCompiled.parameters, num_images: 2 } }));
    const trace: string[] = [];
    for (let i = 0; i < 6; i++) { const r = await tickWorker(deps, "w1"); trace.push(`${r.processedRunId === run.id ? "p" : "-"}:${status(run.id).status}`); }
    expect(trace).toEqual(["p:queued", "p:queued", "p:running", "p:downloading", "p:succeeded", "-:succeeded"]);
    const { run: done, candidates } = await getRun(deps, run.id);
    expect(done).toMatchObject({ status: "succeeded", errorCode: null, actualCost: { kind: "unknown" } });
    expect(candidates.map(c => c.index)).toEqual([0, 1]);
    for (const c of candidates) {
      expect(c).toMatchObject({ runId: run.id, parentCandidateId: null, seed: 1 });
      const media = deps.repo.get("media", c.mediaId)!;
      expect(media).toMatchObject({ source: "generated", mime: "image/png", width: 1, height: 1 });
      expect(await deps.blobs.read(media.relativePath)).toEqual(png());
    }
    expect(await rejection(Promise.resolve().then(() => deps.repo.insert("candidates", { ...candidates[0], id: id(4444) })))).toBe("CONFLICT");
  });
  it("does nothing while another owner holds the lease, and returns null with no active run", async () => {
    expect(deps.repo.acquireLease("other", now, at(60_000))).toBe(true);
    const run = await submit(addPreview(1));
    expect(await tickWorker(deps, "w1")).toEqual({ processedRunId: null });
    expect(status(run.id).status).toBe("draft");
    clock = at(60_000);
    expect((await tickWorker(deps, "w1")).processedRunId).toBe(run.id);
    expect(await rejection(tickWorker(deps, " "))).toBe("VALIDATION");
  });
  it("fails only explicit rejections; unknown submission errors stop without resubmitting", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    fake.submitImpl = async () => { throw new SubmissionError("rejected", "422 invalid input"); };
    const a = await submit(addPreview(1)); await tickWorker(deps, "w1");
    expect(status(a.id)).toMatchObject({ status: "failed", errorCode: "SUBMISSION_REJECTED" });
    fake.submitImpl = async () => { throw new SubmissionError("unknown", "socket hang up"); };
    const b = await submit(addPreview(2)); for (let i = 0; i < 4; i++) await tickWorker(deps, "w1");
    expect(status(b.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN", providerRequestId: null });
    expect(fake.calls.submit).toBe(2);
  });
  it("marks a 30s submit timeout unknown and ignores the late response", async () => {
    vi.useFakeTimers();
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    let release!: (v: { requestId: string }) => void;
    fake.submitImpl = () => new Promise(resolve => { release = resolve; });
    const run = await submit(addPreview(1));
    const tick = tickWorker(deps, "w1"); await vi.advanceTimersByTimeAsync(30_000); await tick;
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_TIMEOUT" });
    release({ requestId: "late" }); await vi.advanceTimersByTimeAsync(0);
    expect(status(run.id).providerRequestId).toBeNull();
    await tickWorker(deps, "w1"); expect(fake.calls.submit).toBe(1);
  });
  it("records nothing after losing the lease mid-submit; the next owner marks it unknown", async () => {
    vi.useFakeTimers();
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    let release!: (v: { requestId: string }) => void;
    fake.submitImpl = () => new Promise(resolve => { release = resolve; });
    const run = await submit(addPreview(1));
    const tick = tickWorker(deps, "w1");
    await vi.advanceTimersByTimeAsync(1); clock = at(61_000); deps.repo.acquireLease("w2", clock, at(121_000));
    await vi.advanceTimersByTimeAsync(10_000); release({ requestId: "after-loss" }); await tick;
    expect(status(run.id)).toMatchObject({ status: "submitting", providerRequestId: null });
    clock = at(122_000); await tickWorker(deps, "w2");
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_INTERRUPTED" });
    expect(fake.calls.submit).toBe(1);
  });
  it("recovers an interrupted submitting run as unknown without calling submit", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    addPreview(1); const runId = insertRun(id(1), { status: "submitting" });
    await tickWorker(deps, "w1");
    expect(status(runId).status).toBe("submission_unknown"); expect(fake.calls.submit).toBe(0);
  });
  it("resumes polling after a restart with a fresh adapter instance", async () => {
    const run = await submit(addPreview(1)); await tickWorker(deps, "w1");
    expect(status(run.id).status).toBe("queued");
    useAdapters(new MockAdapter());
    expect((await tickWorker(deps, "w2-after-restart")).processedRunId).toBeNull(); // old lease still valid
    clock = at(60_000);
    for (let i = 0; i < 5; i++) await tickWorker(deps, "w2-after-restart");
    expect(status(run.id).status).toBe("succeeded");
  });
  it("keeps state on poll errors, ignores running→queued and fails on provider FAILED", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    const run = await submit(addPreview(1)); await tickWorker(deps, "w1");
    fake.pollImpl = async () => ({ status: "running" }); await tickWorker(deps, "w1");
    fake.pollImpl = async () => { throw new Error("503"); }; await tickWorker(deps, "w1");
    expect(status(run.id)).toMatchObject({ status: "running", errorCode: "PROVIDER_POLL" });
    fake.pollImpl = async () => ({ status: "queued" }); await tickWorker(deps, "w1");
    expect(status(run.id)).toMatchObject({ status: "running", errorCode: null });
    fake.pollImpl = async () => ({ status: "failed", code: "NSFW" }); await tickWorker(deps, "w1");
    expect(status(run.id)).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILED:NSFW" });
    expect(fake.calls.submit).toBe(1);
  });
  it("moves a failed download to download_failed and retries only the download", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    const run = await submit(addPreview(1)); await tickWorker(deps, "w1"); await tickWorker(deps, "w1");
    fake.downloadImpl = async () => { throw new Error("ECONNRESET"); }; await tickWorker(deps, "w1");
    expect(status(run.id)).toMatchObject({ status: "download_failed", errorCode: "DOWNLOAD_FAILED" });
    for (let i = 0; i < 3; i++) expect((await tickWorker(deps, "w1")).processedRunId).toBeNull();
    fake.downloadImpl = async () => [{ bytes: png(), mime: "image/png", seed: 3 }];
    expect((await retryDownload(deps, run.id)).status).toBe("downloading");
    await tickWorker(deps, "w1");
    expect((await getRun(deps, run.id)).candidates).toHaveLength(1);
    expect(fake.calls).toMatchObject({ submit: 1, download: 2 });
  });
  it("rejects outputs with the wrong count, format or (for live adapters) size", async () => {
    const mock = new FakeAdapter("mock-reference"); const live = new FakeAdapter("fal-flux2-edit"); useAdapters(mock, live);
    const runTo = async (n: number, adapter: FakeAdapter, outputs: ProviderOutput[], compiled: Partial<Compiled> = {}, consent: Record<string, unknown> = {}) => {
      adapter.downloadImpl = async () => outputs;
      const run = await submit(addPreview(n, compiled), consent); for (let i = 0; i < 3; i++) await tickWorker(deps, "w1");
      const result = status(run.id); terminate(run.id); return result;
    };
    expect(await runTo(1, mock, [{ bytes: png(), mime: "image/png", seed: 1 }, { bytes: png(), mime: "image/png", seed: 2 }])).toMatchObject({ status: "download_failed", errorCode: "OUTPUT_COUNT" });
    expect(await runTo(2, mock, [{ bytes: new TextEncoder().encode("not png"), mime: "image/png", seed: 1 }])).toMatchObject({ status: "download_failed" });
    expect(await runTo(3, live, [{ bytes: png(), mime: "image/png", seed: 1 }], { adapterId: "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", estimate: unknown }, { acceptUnknownCost: true, maxEstimatedCostMicros: null })).toMatchObject({ status: "download_failed", errorCode: "OUTPUT_SIZE" });
    expect(deps.repo.list("candidates", ids.project)).toEqual([]);
    expect(live.calls.submit + mock.calls.submit).toBe(3);
  });
  it("fails before submitting when references or the adapter are unavailable", async () => {
    const fake = new FakeAdapter("mock-reference"); useAdapters(fake);
    const a = await submit(addPreview(1, { references: [{ mediaId: id(4242), role: "character", note: "" }] }));
    await tickWorker(deps, "w1");
    expect(status(a.id)).toMatchObject({ status: "failed", errorCode: "REFERENCE_UNAVAILABLE" });
    const b = await submit(addPreview(2)); useAdapters();
    await tickWorker(deps, "w1");
    expect(status(b.id)).toMatchObject({ status: "failed", errorCode: "ADAPTER_UNAVAILABLE" });
    expect(fake.calls.submit).toBe(0);
  });
});

describe("recovery actions", () => {
  it("attaches a known request ID to an unknown run and completes it", async () => {
    const mock = new MockAdapter(); const { requestId } = await mock.submit(baseCompiled, [], { signal: new AbortController().signal, mayPost: () => true });
    addPreview(1); const runId = insertRun(id(1), { status: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN" });
    expect(await resolveRun(deps, runId, { action: "attach", providerRequestId: requestId })).toMatchObject({ status: "queued", providerRequestId: requestId, errorCode: null });
    for (let i = 0; i < 4; i++) await tickWorker(deps, "w1");
    expect(status(runId).status).toBe("succeeded");
  });
  it("abandons unknown or failed downloads only, and frees the active slot", async () => {
    addPreview(1); const unknownRun = insertRun(id(1), { status: "submission_unknown" });
    expect(await rejection(submit(addPreview(2)))).toBe("CONFLICT");
    expect(await resolveRun(deps, unknownRun, { action: "abandon", reason: " user gave up " })).toMatchObject({ status: "failed", errorCode: "ABANDONED:user gave up" });
    expect(await rejection(resolveRun(deps, unknownRun, { action: "abandon", reason: "again" }))).toBe("CONFLICT");
    const queued = insertRun(id(2), { status: "queued", providerRequestId: "x" });
    expect(await rejection(resolveRun(deps, queued, { action: "abandon", reason: "x" }))).toBe("CONFLICT");
    expect(await rejection(resolveRun(deps, queued, { action: "attach", providerRequestId: "y" }))).toBe("CONFLICT");
    expect(await rejection(retryDownload(deps, queued))).toBe("CONFLICT");
    expect(await rejection(resolveRun(deps, queued, { action: "abandon", reason: "  " }))).toBe("VALIDATION");
    expect(await rejection(retryDownload(deps, id(31337)))).toBe("NOT_FOUND");
    expect(await rejection(getRun(deps, "nope"))).toBe("VALIDATION");
  });
});

describe("runWorker", () => {
  it("polls every 2s until aborted, then releases the lease", async () => {
    // Loop cadence only: in-memory blob/inspector test doubles keep every step on microtasks so fake timers control time.
    vi.useFakeTimers();
    deps = { ...deps, blobs: { write: async bytes => ({ relativePath: `blobs/${"c".repeat(64)}.png`, sha256: "c".repeat(64), bytes: bytes.length }), read: async () => png() }, imageInspector: { inspect: async () => ({ mime: "image/png", width: 1, height: 1, pages: 1 }) } };
    const run = await submit(addPreview(1));
    const controller = new AbortController(); const loop = runWorker(deps, "loop", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const seen = [status(run.id).status];
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(2_000); seen.push(status(run.id).status); }
    expect(seen).toEqual(["queued", "queued", "running", "downloading", "succeeded"]);
    controller.abort(); await loop;
    expect(deps.repo.acquireLease("someone-else", now, at(60_000))).toBe(true);
  });
  it("survives a failing tick and stops immediately when already aborted", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...deps, repo: { ...deps.repo, list: () => { throw new Error("FAL_KEY=secret"); } } } as Dependencies;
    const controller = new AbortController(); const loop = runWorker(broken, "loop", controller.signal);
    await vi.advanceTimersByTimeAsync(4_000); controller.abort(); await loop;
    expect(errors).toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("secret");
    const aborted = new AbortController(); aborted.abort(); await runWorker(deps, "loop", aborted.signal);
    errors.mockRestore();
  });
});

describe("generation routes", () => {
  const base = "http://127.0.0.1:3000/api/generations";
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) });
  it("submits, replays, reads and recovers runs over HTTP", async () => {
    const preview = addPreview(1);
    const body = { previewId: preview.id, previewHash: preview.hash, idempotencyKey: id(7), acceptUnknownCost: false, maxEstimatedCostMicros: 0 };
    const first = await generationsRoute.POST(post(body)); const { data: run } = await first.json();
    expect(first.status).toBe(200); expect(run.status).toBe("draft");
    expect((await (await generationsRoute.POST(post(body))).json()).data.id).toBe(run.id);
    expect((await (await generationRoute.GET(new Request(base), ctx(run.id))).json()).data).toMatchObject({ run: { id: run.id }, candidates: [] });
    expect((await retryRoute.POST(post({}), ctx(run.id))).status).toBe(409);
    expect((await resolveRoute.POST(post({ action: "abandon", reason: "" }), ctx(run.id))).status).toBe(400);
    expect((await generationsRoute.POST(post({ ...body, acceptUnknownCost: undefined }))).status).toBe(400);
    expect((await generationsRoute.POST(post(body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await generationRoute.GET(new Request(base), ctx(id(31337)))).status).toBe(404);
  });
});
