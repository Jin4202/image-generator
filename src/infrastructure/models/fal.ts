import { createFalClient, type FalClient } from "@fal-ai/client";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { ModelAdapter, ProviderOutput, ProviderStatus, SubmitContext } from "../../application/ports";
import { Compiled, Limits } from "../../contracts";
import { AppError, SubmissionError } from "../../domain/errors";
import { FalInput, FalOutput, type FalTransport } from "./fal-contract";

const endpoints = { "fal-flux2-edit": "fal-ai/flux-2/edit", "fal-flux2-text": "fal-ai/flux-2" } as const;
type FalAdapterId = keyof typeof endpoints;
const knownEndpoints: ReadonlySet<string> = new Set(Object.values(endpoints));
/** Queue responses that clearly refuse the request; everything else after the POST left is ambiguous. */
const rejectedStatuses: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);
const externalTimeoutMs = 30_000;
const maxRedirects = 3;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Separate lists: Node's BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets, so mixing them blocks all IPv4.
const blockedV4 = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blockedV4.addSubnet(net, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [net, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blockedV6.addSubnet(net, prefix, "ipv6");

/** True only for globally routable unicast addresses (no loopback/private/link-local/reserved/IPv4-mapped forms). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family !== 6) return false;
  // Any IPv4-mapped/compatible IPv6 form (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d) is refused outright.
  if (/^(::ffff:|::(\d+\.){3}\d+$)/i.test(address) || /^0{0,4}(:0{0,4}){4}:ffff:/i.test(address)) return false;
  try { return !blockedV6.check(address, "ipv6"); } catch { return false; }
}

const providerError = (code: string): never => { throw new AppError("PROVIDER", code); };
/** T13: the attempt may still post only if it is not cancelled and the synchronous authorization holds (a throwing check means no). */
function mayStillPost(context: SubmitContext): boolean {
  if (context.signal.aborted) return false;
  try { return context.mayPost() === true; } catch { return false; }
}
const cancelled = () => new SubmissionError("rejected", "Submit attempt was cancelled before the paid request");
const isPng = (bytes: Uint8Array) => pngSignature.every((b, i) => bytes[i] === b);
function mimeOf(bytes: Uint8Array): string {
  if (isPng(bytes)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** Validates every resolved address at connect time, so DNS answers cannot swap in a private target after the check. */
export function validatingLookup(resolve: typeof dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 4);
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(Object.assign(new Error("Blocked address"), { code: "EBLOCKED" }), "", 4);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** One HTTPS hop: status, Location and a streamed body. Injected in tests; the default pins validated DNS answers. */
export type OpenUrl = (url: URL, signal: AbortSignal) => Promise<{ status: number; location: string | null; body: AsyncIterable<Uint8Array> & { destroy?: () => void } }>;
function defaultOpen(resolve: typeof dnsLookup = dnsLookup): OpenUrl {
  const lookup = validatingLookup(resolve);
  return (url, signal) => new Promise((done, fail) => {
    const req = httpsRequest(url, { method: "GET", lookup, signal, headers: { accept: "image/png" } }, res => done({ status: res.statusCode ?? 0, location: typeof res.headers.location === "string" ? res.headers.location : null, body: res }));
    req.on("error", fail);
    req.end();
  });
}

/** HTTPS-only download with per-hop target validation, ≤3 redirects, one overall timeout and a streamed 10 MiB cap. */
async function safeDownload(url: string, open: OpenUrl, timeoutMs: number): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current: URL;
  try { current = new URL(url); } catch { return providerError("RESULT_URL_INVALID"); }
  for (let hop = 0; ; hop++) {
    const host = current.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (current.protocol !== "https:" || current.username || current.password || host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && !isPublicAddress(host))) providerError("RESULT_URL_BLOCKED");
    let response: Awaited<ReturnType<OpenUrl>>;
    try { response = await open(current, signal); } catch { return providerError("RESULT_FETCH_FAILED"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.body.destroy?.();
      if (hop >= maxRedirects || !response.location) providerError("RESULT_REDIRECT_REJECTED");
      try { current = new URL(response.location!, current); } catch { return providerError("RESULT_REDIRECT_REJECTED"); }
      continue;
    }
    if (response.status !== 200) { response.body.destroy?.(); providerError("RESULT_FETCH_FAILED"); }
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > Limits.uploadBytes) { response.body.destroy?.(); providerError("RESULT_TOO_LARGE"); }
        chunks.push(chunk);
      }
    } catch (error) { if (error instanceof AppError) throw error; return providerError("RESULT_FETCH_FAILED"); }
    return new Uint8Array(Buffer.concat(chunks));
  }
}

export interface DefaultTransportOptions {
  /** Used only for the direct queue submit (tests inject an HTTP mock). */
  fetch?: typeof fetch;
  /** Instance-scoped SDK client for upload/status/result; never the global `fal` singleton. */
  client?: Pick<FalClient, "queue" | "storage">;
  open?: OpenUrl;
  timeoutMs?: number;
}

/**
 * Default transport. Submit is a single direct POST to the official Queue REST API because
 * @fal-ai/client 1.10.1 forces its own submit retries; upload/status/result use an instance-scoped SDK client.
 */
export function createDefaultFalTransport(key: string, options: DefaultTransportOptions = {}): FalTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? externalTimeoutMs;
  const client = options.client ?? createFalClient({ credentials: key, retry: { maxRetries: 0 } });
  const open = options.open ?? defaultOpen();
  return {
    async submit(endpoint, input, context) {
      if (!knownEndpoints.has(endpoint)) throw new SubmissionError("rejected", "Unknown fal endpoint");
      const payload = JSON.stringify(input);
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      let response: Response;
      // Last authorization and the fetch call run in the same synchronous step: nothing can await in between.
      if (!mayStillPost(context)) throw cancelled();
      try {
        // Exactly one POST: no SDK retry loop, no redirect following, bounded wait.
        response = await fetchImpl(`https://queue.fal.run/${endpoint}`, { method: "POST", headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: payload, redirect: "error", signal });
      } catch { throw new SubmissionError("unknown", "fal queue submit did not complete"); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SubmissionError(rejectedStatuses.has(response.status) ? "rejected" : "unknown", `fal queue submit returned HTTP ${response.status}`);
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new SubmissionError("unknown", "fal queue submit response was unreadable"); }
      const requestId = (body as { request_id?: unknown } | null)?.request_id;
      if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 500) throw new SubmissionError("unknown", "fal queue submit response had no request_id");
      return { request_id: requestId };
    },
    async status(endpoint, requestId) {
      const status = await client.queue.status(endpoint, { requestId, logs: false }) as { status?: string; error?: unknown };
      // The queue reports failures as COMPLETED with an error field.
      if (status.status === "COMPLETED" && status.error) return "FAILED";
      if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS" || status.status === "COMPLETED") return status.status;
      return providerError("POLL_UNRECOGNIZED");
    },
    async result(endpoint, requestId) {
      return (await client.queue.result(endpoint, { requestId })).data;
    },
    async upload(bytes) {
      return client.storage.upload(new Blob([new Uint8Array(bytes)], { type: mimeOf(bytes) }));
    },
    fetchImage: url => safeDownload(url, open, timeoutMs),
  };
}

/** T07: exact public parameters plus ephemeral URLs; no key in payload. */
export function buildFalInput(input: Compiled, referenceUrls: readonly string[]): FalInput {
  const compiled = Compiled.safeParse(input);
  if (!compiled.success) throw new AppError("VALIDATION", "Invalid compiled request");
  const c = compiled.data;
  if (c.adapterId === "mock-reference" || c.endpoint !== endpoints[c.adapterId]) throw new AppError("UNSUPPORTED", "Not a fal request");
  const isEdit = c.adapterId === "fal-flux2-edit";
  if (isEdit ? referenceUrls.length !== c.references.length || referenceUrls.length < 1 || referenceUrls.length > 4 : referenceUrls.length !== 0 || c.references.length !== 0) throw new AppError("UNSUPPORTED", "Reference images do not match the endpoint");
  if (referenceUrls.some(url => !/^https:\/\//.test(url))) throw new AppError("VALIDATION", "Reference URLs must be HTTPS");
  const p = c.parameters;
  const native = FalInput.safeParse({
    prompt: c.prompt, image_size: p.image_size, num_images: p.num_images,
    ...(p.seed === null ? {} : { seed: p.seed }),
    guidance_scale: p.guidance_scale, num_inference_steps: p.num_inference_steps, acceleration: p.acceleration,
    enable_prompt_expansion: p.enable_prompt_expansion, enable_safety_checker: p.enable_safety_checker, output_format: p.output_format, sync_mode: p.sync_mode,
    ...(isEdit ? { image_urls: [...referenceUrls] } : {}),
  });
  if (!native.success) throw new AppError("VALIDATION", "Request does not fit the published fal schema");
  return native.data;
}

/** Errors thrown by an injected transport: only clear HTTP refusals count as not submitted. */
function certaintyOf(error: unknown): "rejected" | "unknown" {
  if (error instanceof SubmissionError) return error.certainty;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && rejectedStatuses.has(status) ? "rejected" : "unknown";
}

/** T07: queue API only; key never persisted/logged; docs/contracts.md#fal. */
export function createFalAdapter(id: "fal-flux2-edit" | "fal-flux2-text", key: string, transport?: FalTransport): ModelAdapter {
  if (!Object.hasOwn(endpoints, id)) throw new AppError("VALIDATION", "Unknown fal adapter");
  if (typeof key !== "string" || !key.trim()) throw new AppError("VALIDATION", "FAL_KEY is required for fal adapters");
  const endpoint = endpoints[id as FalAdapterId];
  const t = transport ?? createDefaultFalTransport(key);
  return {
    id,
    async submit(input, references, context) {
      let native: FalInput;
      try {
        const compiled = Compiled.parse(input);
        if (compiled.adapterId !== id || compiled.endpoint !== endpoint) throw new Error("adapter mismatch");
        if (references.length !== compiled.references.length || references.some(r => !(r instanceof Uint8Array) || r.length === 0)) throw new Error("reference mapping mismatch");
        const urls: string[] = [];
        // Temporary upload URLs live only in memory, in reference order. An upload cannot be stopped, but a cancelled
        // attempt starts no further upload and never reaches the POST.
        for (const bytes of references) {
          if (context.signal.aborted) throw new Error("cancelled");
          urls.push(await t.upload(bytes));
        }
        native = buildFalInput(compiled, urls);
      } catch {
        throw new SubmissionError("rejected", "Request was not submitted: invalid input, reference upload failed or attempt cancelled");
      }
      if (!mayStillPost(context)) throw cancelled();
      let response: { request_id: string };
      try { response = await t.submit(endpoint, native, context); }
      catch (error) { throw new SubmissionError(certaintyOf(error), "fal queue submit failed"); }
      const requestId = response?.request_id;
      if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 500) throw new SubmissionError("unknown", "fal queue submit returned no request_id");
      return { requestId };
    },
    async poll(requestId): Promise<ProviderStatus> {
      let status: Awaited<ReturnType<FalTransport["status"]>>;
      try { status = await t.status(endpoint, requestId); } catch { return providerError("POLL_FAILED"); }
      switch (status) {
        case "IN_QUEUE": return { status: "queued" };
        case "IN_PROGRESS": return { status: "running" };
        case "COMPLETED": return { status: "completed" };
        case "FAILED": return { status: "failed", code: "FAL_FAILED" };
        default: return providerError("POLL_UNRECOGNIZED");
      }
    },
    async download(requestId): Promise<ProviderOutput[]> {
      let raw: unknown;
      try { raw = await t.result(endpoint, requestId); } catch { return providerError("RESULT_FETCH_FAILED"); }
      // Allowlisted parse only; the raw provider response is never stored or returned.
      const parsed = FalOutput.safeParse(raw);
      if (!parsed.success) return providerError("OUTPUT_FORMAT");
      if (parsed.data.has_nsfw_concepts.some(Boolean)) return providerError("OUTPUT_NSFW");
      const outputs: ProviderOutput[] = [];
      for (const image of parsed.data.images) {
        let bytes: Uint8Array;
        try { bytes = await t.fetchImage(image.url); } catch (error) { throw error instanceof AppError ? error : new AppError("PROVIDER", "RESULT_FETCH_FAILED"); }
        if (!isPng(bytes)) providerError("OUTPUT_FORMAT");
        outputs.push({ bytes, mime: "image/png", seed: parsed.data.seed });
      }
      return outputs;
    },
  };
}
