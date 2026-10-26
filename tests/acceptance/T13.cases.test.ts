// T13: no paid POST may start after the attempt timed out, was abandoned, or lost its lease.
// Real runs service + real fal adapter + the default transport's submit over an HTTP mock; uploads are manually controlled
// promises and time is faked. No network, no live fal call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies, SubmitContext } from "../../src/application/ports";
import { resolveRun, submitRun, tickWorker } from "../../src/application/services/runs";
import type { Compiled, Preview } from "../../src/contracts";
import { SubmissionError } from "../../src/domain/errors";
import { createDefaultFalTransport, createFalAdapter } from "../../src/infrastructure/models/fal";
import type { FalInput, FalTransport } from "../../src/infrastructure/models/fal-contract";
import { MOCK_PNG_BASE64, MockAdapter } from "../../src/infrastructure/models/mock";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { compiled as baseCompiled, ids, now, snapshot } from "../support/fixtures";
import { world } from "../support/world";

const KEY = "fal-t13-secret-key";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const png = () => new Uint8Array(Buffer.from(MOCK_PNG_BASE64, "base64"));
const unusedClient = { queue: {} as never, storage: {} as never };
const open = (): SubmitContext => ({ signal: new AbortController().signal, mayPost: () => true });
const native: FalInput = { prompt: "P", image_size: { width: 1024, height: 1024 }, num_images: 1, guidance_scale: 2.5, num_inference_steps: 28, acceleration: "regular", enable_prompt_expansion: false, enable_safety_checker: true, output_format: "png", sync_mode: false };
const certainty = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (e) { return e instanceof SubmissionError ? e.certainty : String(e); } };

type Pending = { resolve: (url: string) => void; reject: (error: unknown) => void };
let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string; let seq: number;
let uploads: Pending[]; let posts: RequestInit[]; let respond: (init: RequestInit) => Promise<Response>;
let unhandled: unknown[]; const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(async () => {
  w = world(); clock = now; seq = 1000; uploads = []; posts = []; unhandled = [];
  respond = async () => Response.json({ request_id: "req-1" });
  process.on("unhandledRejection", onUnhandled);
  deps = { ...w.deps, blobs: createLocalBlobStore(w.root), now: () => clock, newId: () => id(seq++) };
  const stored = await deps.blobs.write(png(), "png");
  deps.repo.insert("media", { id: id(500), projectId: ids.project, revision: 0, createdAt: now, ...stored, mime: "image/png", width: 1, height: 1, source: "upload", licenseNotes: "" });
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => { posts.push(init ?? {}); return respond(init ?? {}); }) as typeof fetch;
  const real = createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient });
  const transport: FalTransport = { ...real, upload: () => new Promise<string>((resolve, reject) => uploads.push({ resolve, reject })) };
  deps = { ...deps, adapters: new Map([["fal-flux2-edit", createFalAdapter("fal-flux2-edit", KEY, transport)]]) };
});
afterEach(() => { vi.useRealTimers(); process.off("unhandledRejection", onUnhandled); w.dispose(); });

/** A fal edit run with `refs` references to the stored media (unknown price, explicit consent, no budget). */
async function editRun(n: number, refs = 1) {
  const compiled: Compiled = { ...structuredClone(baseCompiled), adapterId: "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", references: Array.from({ length: refs }, () => ({ mediaId: id(500), role: "character" as const, note: "" })), estimate: { kind: "unknown", reason: "pricing-not-configured" } };
  const preview: Preview = { id: id(n), projectId: ids.project, revision: 0, createdAt: now, snapshot: structuredClone(snapshot), compiled, hash: String(n % 10).repeat(64), expiresAt: at(900_000) };
  deps.repo.insert("previews", preview);
  return submitRun(deps, { previewId: preview.id, previewHash: preview.hash, idempotencyKey: id(n + 5000), acceptUnknownCost: true, maxEstimatedCostMicros: null });
}
const status = (runId: string) => deps.repo.get("runs", runId)!;
/** Lets the started tick reach the pending upload (reference blob read is real file I/O). */
async function untilUploads(count: number) { for (let i = 0; i < 200 && uploads.length < count; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise(r => setImmediate(r)); } expect(uploads).toHaveLength(count); }

describe("timeout while the reference upload is pending", () => {
  it("timeout → unknown → abandon → upload completes: zero paid POSTs, run stays failed with no request ID", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1, 2);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    await vi.advanceTimersByTimeAsync(30_000); await tick;
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_TIMEOUT", providerRequestId: null });
    expect(vi.getTimerCount()).toBe(0);
    expect((await resolveRun(deps, run.id, { action: "abandon", reason: "upload stuck" })).status).toBe("failed");
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await vi.advanceTimersByTimeAsync(0); await new Promise(r => setImmediate(r));
    expect(posts).toHaveLength(0);
    expect(uploads).toHaveLength(1); // the cancelled attempt starts no further upload
    expect(status(run.id)).toMatchObject({ status: "failed", providerRequestId: null, errorCode: "ABANDONED:upload stuck" });
    await tickWorker(deps, "w1"); expect(posts).toHaveLength(0);
  });
  it("a late upload rejection after the timeout is handled (no unhandled rejection) and posts nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    await vi.advanceTimersByTimeAsync(30_000); await tick;
    uploads[0].reject(new Error("storage socket closed")); await vi.advanceTimersByTimeAsync(0); await new Promise(r => setImmediate(r));
    expect(unhandled).toEqual([]); expect(posts).toHaveLength(0);
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_TIMEOUT" });
  });
});

describe("lease loss while the reference upload is pending", () => {
  it("heartbeat detects the takeover: the attempt stops, the late upload posts nothing, the new owner marks it unknown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    clock = at(61_000); expect(deps.repo.acquireLease("w2", clock, at(121_000))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); await tick; // returns on lease loss without waiting for the upload
    expect(vi.getTimerCount()).toBe(0);
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await vi.advanceTimersByTimeAsync(0); await new Promise(r => setImmediate(r));
    expect(posts).toHaveLength(0);
    expect(status(run.id)).toMatchObject({ status: "submitting", providerRequestId: null });
    clock = at(122_000); await tickWorker(deps, "w2");
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_INTERRUPTED" });
    expect(posts).toHaveLength(0);
  });
  it("another worker took over before any heartbeat: the synchronous pre-POST check refuses and nothing is recorded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    clock = at(61_000); deps.repo.acquireLease("w2", clock, at(121_000));
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await tick;
    expect(posts).toHaveLength(0);
    expect(status(run.id)).toMatchObject({ status: "submitting", providerRequestId: null, revision: 1 });
  });
  it("the run moved while the upload was pending (same owner): no POST", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    const current = status(run.id); deps.repo.replace("runs", { ...current, revision: current.revision + 1, status: "submission_unknown", errorCode: "TEST" }, current.revision);
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await tick;
    expect(posts).toHaveLength(0);
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "TEST", providerRequestId: null });
  });
});

describe("normal and already-sent submissions", () => {
  it("normal submit: exactly one POST carrying an abort signal, run queued with the request ID, timers cleaned up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = await editRun(1, 2);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await untilUploads(2);
    uploads[1].resolve("https://storage.example.com/ref-2.png"); await tick;
    expect(posts).toHaveLength(1);
    expect(posts[0].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(posts[0].body)).image_urls).toEqual(["https://storage.example.com/ref-1.png", "https://storage.example.com/ref-2.png"]);
    expect(status(run.id)).toMatchObject({ status: "queued", providerRequestId: "req-1" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("POST already started, then the deadline passes: unknown, the in-flight request is aborted, never resubmitted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    respond = init => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); await tick;
    expect(posts[0].signal?.aborted).toBe(true);
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_TIMEOUT", providerRequestId: null });
    for (let i = 0; i < 3; i++) await tickWorker(deps, "w1");
    expect(posts).toHaveLength(1); expect(unhandled).toEqual([]);
  });
  it("POST sent but the response is lost: unknown and no resubmit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    respond = async () => { throw new TypeError("socket hang up"); };
    const run = await editRun(1);
    const tick = tickWorker(deps, "w1"); await untilUploads(1);
    uploads[0].resolve("https://storage.example.com/ref-1.png"); await tick;
    for (let i = 0; i < 3; i++) await tickWorker(deps, "w1");
    expect(status(run.id)).toMatchObject({ status: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN" });
    expect(posts).toHaveLength(1);
  });
});

describe("submit context contract at the adapter and transport boundary", () => {
  it("default transport checks authorization synchronously right before fetch and refuses without sending otherwise", async () => {
    let fetches = 0; let checkedThisTurn = false; let sameTurn: boolean | null = null;
    const fetchMock = (async () => { fetches++; sameTurn = checkedThisTurn; return Response.json({ request_id: "abc" }); }) as typeof fetch;
    const transport = createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient });
    const mayPost = () => { checkedThisTurn = true; queueMicrotask(() => { checkedThisTurn = false; }); return true; };
    expect(await transport.submit("fal-ai/flux-2", native, { signal: new AbortController().signal, mayPost })).toEqual({ request_id: "abc" });
    expect(sameTurn).toBe(true);
    const aborted = new AbortController(); aborted.abort();
    expect(await certainty(transport.submit("fal-ai/flux-2", native, { signal: aborted.signal, mayPost: () => true }))).toBe("rejected");
    expect(await certainty(transport.submit("fal-ai/flux-2", native, { signal: new AbortController().signal, mayPost: () => false }))).toBe("rejected");
    expect(await certainty(transport.submit("fal-ai/flux-2", native, { signal: new AbortController().signal, mayPost: () => { throw new Error("db closed"); } }))).toBe("rejected");
    expect(fetches).toBe(1);
  });
  it("default transport forwards the attempt signal to the HTTP request", async () => {
    let seen: AbortSignal | undefined;
    const fetchMock = ((_: unknown, init?: RequestInit) => { seen = init?.signal ?? undefined; return new Promise((_, reject) => seen?.addEventListener("abort", () => reject(new Error("aborted")))); }) as typeof fetch;
    const controller = new AbortController();
    const pending = certainty(createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient }).submit("fal-ai/flux-2", native, { signal: controller.signal, mayPost: () => true }));
    controller.abort();
    expect(await pending).toBe("unknown"); // the POST had already started
    expect(seen?.aborted).toBe(true);
  });
  it("adapter: an attempt aborted between uploads starts no further upload; a refused authorization never calls transport.submit", async () => {
    const calls: string[] = []; const controller = new AbortController();
    const transport: FalTransport = { submit: async () => { calls.push("submit"); return { request_id: "x" }; }, status: async () => "IN_QUEUE", result: async () => ({}), fetchImage: async () => png(), upload: async () => { calls.push("upload"); controller.abort(); return "https://storage.example.com/a.png"; } };
    const edit: Compiled = { ...structuredClone(baseCompiled), adapterId: "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", references: [{ mediaId: id(500), role: "character", note: "" }, { mediaId: id(500), role: "sketch", note: "" }], estimate: { kind: "unknown", reason: "pricing-not-configured" } };
    expect(await certainty(createFalAdapter("fal-flux2-edit", KEY, transport).submit(edit, [png(), png()], { signal: controller.signal, mayPost: () => true }))).toBe("rejected");
    expect(calls).toEqual(["upload"]);
    calls.length = 0; transport.upload = async () => { calls.push("upload"); return "https://storage.example.com/a.png"; };
    expect(await certainty(createFalAdapter("fal-flux2-edit", KEY, transport).submit(edit, [png(), png()], { signal: new AbortController().signal, mayPost: () => false }))).toBe("rejected");
    expect(calls).toEqual(["upload", "upload"]);
    expect(await createFalAdapter("fal-flux2-edit", KEY, transport).submit(edit, [png(), png()], open())).toEqual({ requestId: "x" });
  });
  it("mock adapter honours the same gate", async () => {
    const aborted = new AbortController(); aborted.abort();
    expect(await certainty(new MockAdapter().submit(baseCompiled, [], { signal: aborted.signal, mayPost: () => true }))).toBe("rejected");
    expect(await certainty(new MockAdapter().submit(baseCompiled, [], { signal: new AbortController().signal, mayPost: () => false }))).toBe("rejected");
    expect((await new MockAdapter().submit(baseCompiled, [], open())).requestId).toMatch(/^mock:/);
  });
});
