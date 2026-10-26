// T07 normal/error/boundary cases. Every transport, HTTP call, SDK client and DNS resolver here is a test double:
// no live fal request, no network. A global fetch spy proves it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import type { Dependencies } from "../../src/application/ports";
import type { Compiled } from "../../src/contracts";
import { SubmissionError } from "../../src/domain/errors";
import { buildFalInput, createDefaultFalTransport, createFalAdapter, isPublicAddress, validatingLookup, type OpenUrl } from "../../src/infrastructure/models/fal";
import type { FalInput, FalTransport } from "../../src/infrastructure/models/fal-contract";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { compiled, ids, now } from "../support/fixtures";

let realNetworkCalls = 0;
beforeAll(() => { vi.stubGlobal("fetch", async () => { realNetworkCalls++; throw new Error("real network used in T07 tests"); }); });
afterAll(() => { vi.unstubAllGlobals(); expect(realNetworkCalls).toBe(0); });

const KEY = "fal-test-secret-key";
const png = () => new Uint8Array(Buffer.from(MOCK_PNG_BASE64, "base64"));
const edit: Compiled = { ...structuredClone(compiled), adapterId: "fal-flux2-edit", endpoint: "fal-ai/flux-2/edit", prompt: "P", references: [{ mediaId: ids.media, role: "character", note: "" }, { mediaId: ids.candidate, role: "sketch", note: "" }], estimate: { kind: "unknown", reason: "pricing-not-configured" } };
const text: Compiled = { ...structuredClone(compiled), adapterId: "fal-flux2-text", endpoint: "fal-ai/flux-2", prompt: "P", estimate: { kind: "unknown", reason: "pricing-not-configured" } };
const err = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (e) { return e instanceof SubmissionError ? `submission:${e.certainty}` : (e as { code?: string; message?: string }).code === "PROVIDER" ? `provider:${(e as Error).message}` : (e as { code?: string }).code ?? String(e); } };
const syncErr = (work: () => unknown) => { try { work(); return "no error"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

/** Recording transport double. */
function fakeTransport(overrides: Partial<FalTransport> = {}) {
  const calls: { op: string; args: unknown[] }[] = []; let uploads = 0;
  const transport: FalTransport = {
    submit: async (...args) => { calls.push({ op: "submit", args }); return { request_id: "req-1" }; },
    status: async (...args) => { calls.push({ op: "status", args }); return "IN_QUEUE"; },
    result: async (...args) => { calls.push({ op: "result", args }); return { images: [{ url: "https://cdn.example.com/a.png" }], seed: 42, has_nsfw_concepts: [false] }; },
    upload: async bytes => { calls.push({ op: "upload", args: [bytes.length] }); return `https://storage.example.com/ref-${++uploads}.png`; },
    fetchImage: async url => { calls.push({ op: "fetchImage", args: [url] }); return png(); },
    ...overrides,
  };
  return { transport, calls, count: (op: string) => calls.filter(c => c.op === op).length };
}

describe("buildFalInput", () => {
  it("maps the edit request exactly, in reference order", () => {
    expect(buildFalInput(edit, ["https://s.example.com/1.png", "https://s.example.com/2.png"])).toEqual({
      prompt: "P", image_size: { width: 1280, height: 720 }, num_images: 1, seed: 1, guidance_scale: 2.5, num_inference_steps: 28, acceleration: "regular",
      enable_prompt_expansion: false, enable_safety_checker: true, output_format: "png", sync_mode: false, image_urls: ["https://s.example.com/1.png", "https://s.example.com/2.png"],
    });
  });
  it("omits a null seed and image_urls for text, and never adds unsupported fields", () => {
    const native = buildFalInput({ ...text, parameters: { ...text.parameters, seed: null } }, []);
    expect(native).not.toHaveProperty("seed"); expect(native).not.toHaveProperty("image_urls");
    for (const field of ["negative_prompt", "mask_url", "loras", "controlnet", "apiKey", "key"]) expect(native).not.toHaveProperty(field);
    expect(Object.keys(native).sort()).toEqual(["acceleration", "enable_prompt_expansion", "enable_safety_checker", "guidance_scale", "image_size", "num_images", "num_inference_steps", "output_format", "prompt", "sync_mode"]);
  });
  it("rejects mismatched reference URLs, non-HTTPS URLs and non-fal requests", () => {
    expect(syncErr(() => buildFalInput(edit, ["https://s.example.com/1.png"]))).toBe("UNSUPPORTED");
    expect(syncErr(() => buildFalInput({ ...edit, references: [] }, []))).toBe("UNSUPPORTED");
    expect(syncErr(() => buildFalInput(text, ["https://s.example.com/1.png"]))).toBe("UNSUPPORTED");
    expect(syncErr(() => buildFalInput(edit, ["http://s.example.com/1.png", "https://s.example.com/2.png"]))).toBe("VALIDATION");
    expect(syncErr(() => buildFalInput(compiled, []))).toBe("UNSUPPORTED");
    expect(syncErr(() => buildFalInput({ ...edit, endpoint: "fal-ai/other" }, ["https://a.example.com/1", "https://a.example.com/2"]))).toBe("UNSUPPORTED");
  });
});

describe("createFalAdapter with an injected transport", () => {
  it("uploads each reference in order, binds URLs and submits exactly once without leaking the key", async () => {
    const { transport, calls, count } = fakeTransport();
    const input = structuredClone(edit); const before = structuredClone(input);
    expect(await createFalAdapter("fal-flux2-edit", KEY, transport).submit(input, [png(), new Uint8Array([1, 2, 3])])).toEqual({ requestId: "req-1" });
    expect(calls.map(c => c.op)).toEqual(["upload", "upload", "submit"]);
    expect(calls[2].args[0]).toBe("fal-ai/flux-2/edit");
    expect((calls[2].args[1] as FalInput).image_urls).toEqual(["https://storage.example.com/ref-1.png", "https://storage.example.com/ref-2.png"]);
    expect(input).toEqual(before); expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(count("submit")).toBe(1);
  });
  it("treats pre-submit failures as certainly not submitted", async () => {
    const cases: [Compiled, Uint8Array[], Partial<FalTransport>][] = [
      [text, [], {}], // text compiled sent to edit adapter
      [edit, [png()], {}], // byte/reference count mismatch
      [edit, [png(), new Uint8Array()], {}], // empty reference
      [edit, [png(), png()], { upload: async () => { throw new Error("storage down"); } }],
      [edit, [png(), png()], { upload: async () => "http://insecure.example.com/x.png" }],
    ];
    for (const [input, refs, overrides] of cases) {
      const { transport, count } = fakeTransport(overrides);
      expect(await err(createFalAdapter("fal-flux2-edit", KEY, transport).submit(input, refs))).toBe("submission:rejected");
      expect(count("submit")).toBe(0);
    }
  });
  it("classifies submit failures: clear refusals rejected, everything else unknown", async () => {
    const outcome = async (submit: FalTransport["submit"]) => err(createFalAdapter("fal-flux2-text", KEY, fakeTransport({ submit }).transport).submit(text, []));
    expect(await outcome(async () => { throw Object.assign(new Error("x"), { status: 422 }); })).toBe("submission:rejected");
    expect(await outcome(async () => { throw Object.assign(new Error("x"), { status: 401 }); })).toBe("submission:rejected");
    expect(await outcome(async () => { throw Object.assign(new Error("x"), { status: 500 }); })).toBe("submission:unknown");
    expect(await outcome(async () => { throw Object.assign(new Error("x"), { status: 429 }); })).toBe("submission:unknown");
    expect(await outcome(async () => { throw new TypeError("fetch failed"); })).toBe("submission:unknown");
    expect(await outcome(async () => ({}) as { request_id: string })).toBe("submission:unknown");
    expect(await outcome(async () => ({ request_id: "  " }))).toBe("submission:unknown");
  });
  it("normalizes queue statuses and surfaces unrecognized ones as provider errors", async () => {
    for (const [raw, expected] of [["IN_QUEUE", { status: "queued" }], ["IN_PROGRESS", { status: "running" }], ["COMPLETED", { status: "completed" }], ["FAILED", { status: "failed", code: "FAL_FAILED" }]] as const) {
      expect(await createFalAdapter("fal-flux2-text", KEY, fakeTransport({ status: async () => raw }).transport).poll("r")).toEqual(expected);
    }
    expect(await err(createFalAdapter("fal-flux2-text", KEY, fakeTransport({ status: async () => "WEIRD" as never }).transport).poll("r"))).toBe("provider:POLL_UNRECOGNIZED");
    expect(await err(createFalAdapter("fal-flux2-text", KEY, fakeTransport({ status: async () => { throw new Error("503"); } }).transport).poll("r"))).toBe("provider:POLL_FAILED");
  });
  it("downloads allowlisted PNG results with the returned seed", async () => {
    const { transport, calls } = fakeTransport({ result: async () => ({ images: [{ url: "https://cdn.example.com/a.png", file_name: "x", extra: 1 }, { url: "https://cdn.example.com/b.png" }], seed: 9, has_nsfw_concepts: [false, false], timings: {}, prompt: "P", secret: "drop" }) });
    const outputs = await createFalAdapter("fal-flux2-text", KEY, transport).download("r");
    expect(outputs).toEqual([{ bytes: png(), mime: "image/png", seed: 9 }, { bytes: png(), mime: "image/png", seed: 9 }]);
    expect(calls.filter(c => c.op === "fetchImage").map(c => c.args[0])).toEqual(["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"]);
  });
  it("rejects malformed results, NSFW flags and non-PNG bytes without fetching flagged images", async () => {
    const dl = (overrides: Partial<FalTransport>) => { const t = fakeTransport(overrides); return { run: err(createFalAdapter("fal-flux2-text", KEY, t.transport).download("r")), t }; };
    expect(await dl({ result: async () => ({ images: [], seed: 1, has_nsfw_concepts: [] }) }).run).toBe("provider:OUTPUT_FORMAT");
    expect(await dl({ result: async () => ({ images: [{ url: "https://c.example.com/a.png" }], seed: 1, has_nsfw_concepts: [false, false] }) }).run).toBe("provider:OUTPUT_FORMAT");
    expect(await dl({ result: async () => ({ images: [{ url: "https://c.example.com/a.png", content_type: "image/jpeg" }], seed: 1, has_nsfw_concepts: [false] }) }).run).toBe("provider:OUTPUT_FORMAT");
    const nsfw = dl({ result: async () => ({ images: [{ url: "https://c.example.com/a.png" }], seed: 1, has_nsfw_concepts: [true] }) });
    expect(await nsfw.run).toBe("provider:OUTPUT_NSFW"); expect(nsfw.t.count("fetchImage")).toBe(0);
    expect(await dl({ fetchImage: async () => new TextEncoder().encode("<html>") }).run).toBe("provider:OUTPUT_FORMAT");
    expect(await dl({ result: async () => { throw new Error("gone"); } }).run).toBe("provider:RESULT_FETCH_FAILED");
  });
  it("requires a key and a known adapter id", () => {
    expect(syncErr(() => createFalAdapter("fal-flux2-edit", "  ", fakeTransport().transport))).toBe("VALIDATION");
    expect(syncErr(() => createFalAdapter("mock-reference" as "fal-flux2-edit", KEY, fakeTransport().transport))).toBe("VALIDATION");
  });
});

describe("default transport: direct queue submit", () => {
  type Call = { url: string; init: RequestInit };
  const httpMock = (respond: (call: Call) => Promise<Response>) => {
    const calls: Call[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => { const call = { url: String(url), init: init ?? {} }; calls.push(call); return respond(call); }) as typeof fetch;
    return { calls, fetchMock };
  };
  const unusedClient = { queue: {} as never, storage: {} as never };
  const native = buildFalInput(text, []);

  it("POSTs once to the queue REST endpoint with the key only in the Authorization header", async () => {
    const { calls, fetchMock } = httpMock(async () => Response.json({ request_id: "abc", status_url: "https://queue.fal.run/x" }));
    const transport = createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient });
    expect(await transport.submit("fal-ai/flux-2", native)).toEqual({ request_id: "abc" });
    expect(calls).toHaveLength(1);
    const [call] = calls; const headers = call.init.headers as Record<string, string>;
    expect(call.url).toBe("https://queue.fal.run/fal-ai/flux-2");
    expect(call.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(headers.Authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual(native);
    expect(String(call.init.body)).not.toContain(KEY);
  });
  it("never retries: 429, 500, 503, timeout, disconnect and bad bodies are one POST and unknown", async () => {
    const scenarios: [string, (call: Call) => Promise<Response>][] = [
      ["429", async () => new Response("slow down", { status: 429 })],
      ["500", async () => new Response(`internal ${KEY}`, { status: 500 })],
      ["503", async () => new Response("", { status: 503 })],
      ["timeout", call => new Promise((_, reject) => call.init.signal!.addEventListener("abort", () => reject(call.init.signal!.reason)))],
      ["disconnect", async () => { throw new TypeError("fetch failed: socket hang up"); }],
      ["not json", async () => new Response("<html>", { status: 200 })],
      ["no request_id", async () => Response.json({ status: "IN_QUEUE" })],
      ["redirect", async () => { throw new TypeError("fetch failed: unexpected redirect"); }],
    ];
    for (const [name, respond] of scenarios) {
      const { calls, fetchMock } = httpMock(respond);
      const transport = createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient, timeoutMs: 20 });
      let error: unknown; try { await transport.submit("fal-ai/flux-2", native); } catch (e) { error = e; }
      expect(error, name).toBeInstanceOf(SubmissionError);
      expect((error as SubmissionError).certainty, name).toBe("unknown");
      expect((error as Error).message, name).not.toContain(KEY); expect((error as Error).message, name).not.toContain("internal");
      expect(calls, name).toHaveLength(1);
    }
  });
  it("rejects clear refusals and unknown endpoints without extra requests", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const { calls, fetchMock } = httpMock(async () => new Response("{}", { status }));
      expect(await err(createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient }).submit("fal-ai/flux-2", native))).toBe("submission:rejected");
      expect(calls).toHaveLength(1);
    }
    const { calls, fetchMock } = httpMock(async () => Response.json({ request_id: "x" }));
    expect(await err(createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient }).submit("evil/endpoint", native))).toBe("submission:rejected");
    expect(calls).toHaveLength(0);
  });
  it("uses the injected instance SDK client for upload, status and result", async () => {
    const sdk = {
      storage: { upload: vi.fn(async (blob: Blob) => `https://storage.example.com/${blob.type}`) },
      queue: { status: vi.fn(async () => ({ status: "COMPLETED", error: "boom" })), result: vi.fn(async () => ({ data: { images: [] }, requestId: "r" })) },
    };
    const transport = createDefaultFalTransport(KEY, { client: sdk as never, fetch: (async () => { throw new Error("submit not expected"); }) as typeof fetch });
    expect(await transport.upload(png())).toBe("https://storage.example.com/image/png");
    expect(await transport.status("fal-ai/flux-2/edit", "r")).toBe("FAILED");
    sdk.queue.status.mockResolvedValueOnce({ status: "IN_PROGRESS" } as never);
    expect(await transport.status("fal-ai/flux-2/edit", "r")).toBe("IN_PROGRESS");
    expect(await transport.result("fal-ai/flux-2/edit", "r")).toEqual({ images: [] });
    expect(sdk.queue.status).toHaveBeenCalledWith("fal-ai/flux-2/edit", { requestId: "r", logs: false });
  });
  it("keeps the worker from resubmitting when the real submit path returns 500", async () => {
    const { world } = await import("../support/world");
    const { createLocalBlobStore } = await import("../../src/infrastructure/storage/local");
    const { submitRun, tickWorker } = await import("../../src/application/services/runs");
    const w = world();
    try {
      const { calls, fetchMock } = httpMock(async () => new Response("", { status: 500 }));
      const adapter = createFalAdapter("fal-flux2-text", KEY, createDefaultFalTransport(KEY, { fetch: fetchMock, client: unusedClient }));
      const deps: Dependencies = { ...w.deps, blobs: createLocalBlobStore(w.root), adapters: new Map([[adapter.id, adapter]]) };
      deps.repo.insert("previews", { id: ids.preview, projectId: ids.project, revision: 0, createdAt: now, snapshot: (await import("../support/fixtures")).snapshot, compiled: text, hash: "a".repeat(64), expiresAt: "2026-10-26T00:15:00.000Z" });
      const run = await submitRun(deps, { previewId: ids.preview, previewHash: "a".repeat(64), idempotencyKey: ids.run, acceptUnknownCost: true, maxEstimatedCostMicros: null });
      for (let i = 0; i < 4; i++) await tickWorker(deps, "w");
      expect(deps.repo.get("runs", run.id)).toMatchObject({ status: "submission_unknown", providerRequestId: null });
      expect(calls).toHaveLength(1);
    } finally { w.dispose(); }
  });
});

describe("result image download safety", () => {
  const body = (...chunks: Uint8Array[]) => Object.assign((async function* () { yield* chunks; })(), { destroy: vi.fn() });
  const transportWith = (open: OpenUrl, timeoutMs?: number) => createDefaultFalTransport(KEY, { open, timeoutMs, client: { queue: {} as never, storage: {} as never }, fetch: (async () => { throw new Error("no"); }) as typeof fetch });
  it("follows up to three validated redirects and returns the body", async () => {
    const hops: string[] = [];
    const open: OpenUrl = async url => { hops.push(url.href); return hops.length <= 3 ? { status: 302, location: `https://cdn${hops.length}.example.com/img.png`, body: body() } : { status: 200, location: null, body: body(png()) }; };
    expect(await transportWith(open).fetchImage("https://cdn0.example.com/img.png")).toEqual(png());
    expect(hops).toHaveLength(4);
  });
  it("rejects a fourth redirect and redirects to blocked targets", async () => {
    let n = 0; const loop: OpenUrl = async () => ({ status: 302, location: `https://hop${++n}.example.com/`, body: body() });
    expect(await err(transportWith(loop).fetchImage("https://start.example.com/"))).toBe("provider:RESULT_REDIRECT_REJECTED");
    for (const target of ["http://cdn.example.com/a.png", "https://127.0.0.1/a.png", "https://169.254.169.254/latest", "https://[::1]/a", "https://localhost/a", "https://user:pw@cdn.example.com/a"]) {
      const opened: string[] = [];
      const open: OpenUrl = async url => { opened.push(url.href); return { status: 302, location: target, body: body() }; };
      expect(await err(transportWith(open).fetchImage("https://cdn.example.com/start")), target).toBe("provider:RESULT_URL_BLOCKED");
      expect(opened).toHaveLength(1);
    }
  });
  it("blocks non-HTTPS and private literal URLs before opening anything", async () => {
    const open = vi.fn<OpenUrl>();
    for (const url of ["http://cdn.example.com/a.png", "https://10.0.0.5/a.png", "https://192.168.1.1/a", "https://[fd00::1]/a", "https://sub.localhost/a", "file:///etc/passwd", "not a url"]) {
      expect(await err(transportWith(open).fetchImage(url)), url).toMatch(/provider:RESULT_URL_(BLOCKED|INVALID)/);
    }
    expect(open).not.toHaveBeenCalled();
  });
  it("enforces the streamed 10 MiB cap, non-200 statuses and the timeout", async () => {
    const big = body(new Uint8Array(6 * 1024 * 1024), new Uint8Array(5 * 1024 * 1024));
    expect(await err(transportWith(async () => ({ status: 200, location: null, body: big })).fetchImage("https://cdn.example.com/a"))).toBe("provider:RESULT_TOO_LARGE");
    expect(big.destroy).toHaveBeenCalled();
    const exact = new Uint8Array(10 * 1024 * 1024);
    expect((await transportWith(async () => ({ status: 200, location: null, body: body(exact) })).fetchImage("https://cdn.example.com/a")).length).toBe(exact.length);
    expect(await err(transportWith(async () => ({ status: 404, location: null, body: body() })).fetchImage("https://cdn.example.com/a"))).toBe("provider:RESULT_FETCH_FAILED");
    const hang: OpenUrl = (_url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    expect(await err(transportWith(hang, 20).fetchImage("https://cdn.example.com/a"))).toBe("provider:RESULT_FETCH_FAILED");
  });
  it("classifies addresses and validates every DNS answer at connect time", async () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd12::1", "::ffff:127.0.0.1", "2001:db8::1", "not-ip"]) expect(isPublicAddress(a), a).toBe(false);
    const resolver = (answers: LookupAddress[]) => ((_host: string, _opts: unknown, cb: (e: null, a: LookupAddress[]) => void) => cb(null, answers)) as never;
    const run = (answers: LookupAddress[], all: boolean) => new Promise<{ error: unknown; address: unknown }>(resolve => validatingLookup(resolver(answers))("cdn.example.com", { all }, (error, address) => resolve({ error, address })));
    expect((await run([{ address: "8.8.8.8", family: 4 }], false))).toEqual({ error: null, address: "8.8.8.8" });
    expect((await run([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], false)).error).toMatchObject({ code: "EBLOCKED" });
    expect((await run([], false)).error).toMatchObject({ code: "EBLOCKED" });
    expect((await run([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }], true)).address).toHaveLength(2);
  });
});

describe("GET /api/models", () => {
  const read = async () => {
    const { GET } = await import("../../src/app/api/models/route");
    const response = await GET(); return { status: response.status, text: await response.clone().text(), body: await response.json() };
  };
  const withEnv = async (env: Record<string, string | undefined>, work: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { await work(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  it("reports fal NOT_CONFIGURED unless provider=fal with a key, and mock as product scope", async () => {
    await withEnv({ GENERATION_PROVIDER: undefined, FAL_KEY: undefined }, async () => {
      const { status, body } = await read();
      expect(status).toBe(200);
      expect(body.data[0]).toMatchObject({ id: "mock-reference", available: true, scope: "product", reason: null });
      expect(body.data.slice(1).map((m: { available: boolean; reason: string }) => [m.available, m.reason])).toEqual([[false, "NOT_CONFIGURED"], [false, "NOT_CONFIGURED"]]);
    });
    await withEnv({ GENERATION_PROVIDER: "fal", FAL_KEY: undefined }, async () => { expect((await read()).body.data[1].available).toBe(false); });
    await withEnv({ GENERATION_PROVIDER: "mock", FAL_KEY: KEY }, async () => { expect((await read()).body.data[1].available).toBe(false); });
    await withEnv({ GENERATION_PROVIDER: "fal", FAL_KEY: KEY }, async () => {
      const { body, text } = await read();
      expect(body.data.slice(1).map((m: { available: boolean; reason: null }) => [m.available, m.reason])).toEqual([[true, null], [true, null]]);
      expect(text).not.toContain(KEY);
    });
  });
});
