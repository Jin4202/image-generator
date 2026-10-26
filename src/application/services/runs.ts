import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies, ModelAdapter, ProviderOutput } from "../ports";
import { AppError } from "../../domain/errors";
import { submissionFailureState, transition } from "../../domain/run-state";

const activeStatuses: ReadonlySet<C.RunStatus> = new Set(["draft", "submitting", "queued", "running", "downloading", "download_failed", "submission_unknown"]);
/** Upper bound for one external provider call (submit, poll or download). */
const externalTimeoutMs = 30_000;
const heartbeatMs = 10_000;
const ownerMaxLength = 200;

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label}`);
  return parsed.data;
}
function findRun(deps: Dependencies, id: string): C.Run {
  const run = deps.repo.get("runs", parse(C.Id, id, "run ID"));
  if (!run) throw new AppError("NOT_FOUND", "Run not found");
  return run;
}

/** Budget rule: reserve known actual cost, else known estimate; any run with neither blocks a finite budget. */
function checkCost(estimate: C.Money, input: z.infer<typeof C.SubmitInput>, project: C.Project, projectRuns: readonly C.Run[]): void {
  if (estimate.kind === "known") {
    if (input.maxEstimatedCostMicros === null) throw new AppError("VALIDATION", "maxEstimatedCostMicros is required for a known estimate");
    if (estimate.micros > input.maxEstimatedCostMicros) throw new AppError("BUDGET_EXCEEDED", "Estimate exceeds the accepted maximum");
  } else {
    if (!input.acceptUnknownCost || input.maxEstimatedCostMicros !== null) throw new AppError("COST_UNKNOWN", "Price is unknown; explicit consent with no maximum is required");
    if (project.budgetMicros !== null) throw new AppError("COST_UNKNOWN", "Unknown prices cannot be submitted against a finite project budget");
  }
  if (project.budgetMicros === null || estimate.kind !== "known") return;
  let reserved = 0;
  for (const run of projectRuns) {
    const cost = run.actualCost.kind === "known" ? run.actualCost : run.compiled.estimate;
    if (cost.kind !== "known") throw new AppError("COST_UNKNOWN", "A previous run has unknown cost; the finite budget cannot be checked");
    reserved += cost.micros;
  }
  if (reserved + estimate.micros > project.budgetMicros) throw new AppError("BUDGET_EXCEEDED", "Project budget would be exceeded");
}

/** T06: docs/contracts.md#runs. Preserve signature; implement all listed invariants. */
export async function submitRun(deps: Dependencies, input: z.infer<typeof C.SubmitInput>): Promise<C.Run> {
  const data = parse(C.SubmitInput, input, "submit request");
  // One BEGIN IMMEDIATE transaction serializes replay lookup, the global active cap and budget checks.
  return deps.repo.transaction(tx => {
    const preview = tx.get("previews", data.previewId);
    if (!preview) throw new AppError("NOT_FOUND", "Preview not found");
    const projectRuns = tx.list("runs", preview.projectId);
    const replay = projectRuns.find(r => r.idempotencyKey === data.idempotencyKey) ?? projectRuns.find(r => r.previewId === preview.id);
    if (replay) {
      if (replay.previewId !== preview.id || data.previewHash !== preview.hash) throw new AppError("CONFLICT", "Idempotency key was already used for a different request");
      return replay;
    }
    if (data.previewHash !== preview.hash) throw new AppError("CONFLICT", "Preview hash does not match the stored preview");
    const now = deps.now();
    if (Date.parse(now) >= Date.parse(preview.expiresAt)) throw new AppError("STALE_PREVIEW", "Preview expired; request a new preview");
    const scene = tx.get("scenes", preview.snapshot.sceneId);
    if (!scene || scene.revision !== preview.snapshot.sceneRevision) throw new AppError("STALE_PREVIEW", "Scene changed after the preview; request a new preview");
    if (!deps.adapters.has(preview.compiled.adapterId)) throw new AppError("UNSUPPORTED", "Selected adapter is not available");
    if (tx.list("runs").some(r => activeStatuses.has(r.status))) throw new AppError("CONFLICT", "Another generation is still active");
    const project = tx.get("projects", preview.projectId);
    if (!project) throw new AppError("NOT_FOUND", "Project not found");
    checkCost(preview.compiled.estimate, data, project, projectRuns);
    const run = C.Run.parse({
      id: deps.newId(), projectId: preview.projectId, revision: 0, createdAt: now, previewId: preview.id, idempotencyKey: data.idempotencyKey,
      status: "draft", snapshot: structuredClone(preview.snapshot), compiled: structuredClone(preview.compiled), providerRequestId: null,
      actualCost: { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: now,
    });
    tx.insert("runs", run);
    return run;
  });
}

/** T06: docs/contracts.md#runs. Preserve signature; implement all listed invariants. */
export async function getRun(deps: Dependencies, id: string): Promise<{ run: C.Run; candidates: C.Candidate[] }> {
  const run = findRun(deps, id);
  const candidates = deps.repo.list("candidates", run.projectId).filter(c => c.runId === run.id).sort((a, b) => a.index - b.index);
  return { run, candidates };
}

/** Applies a user-requested transition with CAS; invalid transitions are CONFLICT. */
function userTransition(deps: Dependencies, id: string, allowed: readonly C.RunStatus[], patch: (run: C.Run) => Partial<C.Run> & { status: C.RunStatus }): C.Run {
  const runId = parse(C.Id, id, "run ID");
  return deps.repo.transaction(tx => {
    const run = tx.get("runs", runId);
    if (!run) throw new AppError("NOT_FOUND", "Run not found");
    if (!allowed.includes(run.status)) throw new AppError("CONFLICT", `Run is ${run.status}; this action is not allowed`);
    const changes = patch(run);
    const next = { ...run, ...changes, status: transition(run.status, changes.status), revision: run.revision + 1, updatedAt: deps.now() };
    tx.replace("runs", next, run.revision);
    return next;
  });
}

/** T06: docs/contracts.md#runs. Preserve signature; implement all listed invariants. */
export async function resolveRun(deps: Dependencies, id: string, input: z.infer<typeof C.ResolveInput>): Promise<C.Run> {
  const data = parse(C.ResolveInput, input, "resolve request");
  if (data.action === "attach") return userTransition(deps, id, ["submission_unknown"], () => ({ status: "queued", providerRequestId: data.providerRequestId, errorCode: null }));
  // Abandon only stops local tracking: it neither cancels nor refunds the provider request.
  return userTransition(deps, id, ["submission_unknown", "download_failed"], () => ({ status: "failed", errorCode: `ABANDONED:${data.reason}` }));
}

/** T06: docs/contracts.md#runs. Preserve signature; implement all listed invariants. */
export async function retryDownload(deps: Dependencies, id: string): Promise<C.Run> {
  return userTransition(deps, id, ["download_failed"], () => ({ status: "downloading", errorCode: null }));
}

type Outcome<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

/**
 * Runs one external call with a timeout while renewing the lease; a lost lease forbids recording further side effects.
 * T13: the deadline, a lost lease and the end of the attempt abort the same signal, so late work cannot start a paid request.
 */
async function external<T>(deps: Dependencies, owner: string, work: (signal: AbortSignal) => Promise<T>): Promise<{ outcome: Outcome<T>; leaseLost: boolean }> {
  const controller = new AbortController();
  let leaseLost = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => {
    try { const now = deps.now(); if (!deps.repo.acquireLease(owner, now, later(now, C.Limits.leaseMs))) leaseLost = true; } catch { leaseLost = true; }
    if (leaseLost) controller.abort();
  }, heartbeatMs);
  try {
    // Abort first so a pending authorization check already sees the cancellation, then stop waiting.
    const stopped = new Promise<Outcome<T>>(resolve => {
      controller.signal.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true });
      timer = setTimeout(() => controller.abort(), externalTimeoutMs);
    });
    const call = Promise.resolve().then(() => work(controller.signal)).then(value => ({ kind: "ok" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
    return { outcome: await Promise.race([call, stopped]), leaseLost };
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); controller.abort();
  }
}

/** Worker-side CAS write: requires that this owner still holds the lease and the run has not moved. */
function commit(deps: Dependencies, owner: string, run: C.Run, changes: Partial<C.Run> & { status: C.RunStatus }, extra?: (tx: Parameters<Parameters<Dependencies["repo"]["transaction"]>[0]>[0], now: string) => void): boolean {
  return deps.repo.transaction(tx => {
    const now = deps.now();
    if (!tx.acquireLease(owner, now, later(now, C.Limits.leaseMs))) return false;
    const current = tx.get("runs", run.id);
    if (!current || current.revision !== run.revision) return false;
    extra?.(tx, now);
    tx.replace("runs", { ...current, ...changes, status: transition(current.status, changes.status), revision: current.revision + 1, updatedAt: now }, current.revision);
    return true;
  });
}

async function stepDraft(deps: Dependencies, owner: string, run: C.Run, adapter: ModelAdapter | undefined): Promise<void> {
  if (!adapter) { commit(deps, owner, run, { status: "failed", errorCode: "ADAPTER_UNAVAILABLE" }); return; }
  // Intent first: once `submitting` is durable, a crash can only lead to submission_unknown, never a resubmit.
  if (!commit(deps, owner, run, { status: "submitting" })) return;
  const submitting = deps.repo.get("runs", run.id);
  if (!submitting) return;
  let references: Uint8Array[];
  try {
    references = await Promise.all(submitting.compiled.references.map(async ref => {
      const media = deps.repo.get("media", ref.mediaId);
      if (!media || media.projectId !== run.projectId) throw new AppError("NOT_FOUND", "Reference media missing");
      return deps.blobs.read(media.relativePath);
    }));
  } catch {
    // Nothing reached the provider yet, so this is a certain non-submission.
    commit(deps, owner, submitting, { status: "failed", errorCode: "REFERENCE_UNAVAILABLE" });
    return;
  }
  // Synchronous last check before the paid request: this owner still holds the lease and the run has not moved.
  const authorized = (signal: AbortSignal) => () => {
    if (signal.aborted) return false;
    try {
      return deps.repo.transaction(tx => {
        const now = deps.now();
        if (!tx.acquireLease(owner, now, later(now, C.Limits.leaseMs))) return false;
        const current = tx.get("runs", submitting.id);
        return current !== null && current.status === "submitting" && current.revision === submitting.revision;
      });
    } catch { return false; }
  };
  const { outcome, leaseLost } = await external(deps, owner, signal => adapter.submit(submitting.compiled, references, { signal, mayPost: authorized(signal) }));
  if (leaseLost) return;
  if (outcome.kind === "ok") commit(deps, owner, submitting, { status: "queued", providerRequestId: outcome.value.requestId, errorCode: null });
  else if (outcome.kind === "timeout") commit(deps, owner, submitting, { status: "submission_unknown", errorCode: "SUBMISSION_TIMEOUT" });
  else {
    const state = submissionFailureState(outcome.error);
    commit(deps, owner, submitting, { status: state, errorCode: state === "failed" ? "SUBMISSION_REJECTED" : "SUBMISSION_UNKNOWN" });
  }
}

async function stepPoll(deps: Dependencies, owner: string, run: C.Run, adapter: ModelAdapter | undefined): Promise<void> {
  if (!adapter || !run.providerRequestId) { commit(deps, owner, run, { status: run.status, errorCode: adapter ? "MISSING_REQUEST_ID" : "ADAPTER_UNAVAILABLE" }); return; }
  const requestId = run.providerRequestId;
  const { outcome, leaseLost } = await external(deps, owner, () => adapter.poll(requestId));
  if (leaseLost) return;
  // Transient poll problems keep the state; the next tick asks again.
  if (outcome.kind !== "ok") { commit(deps, owner, run, { status: run.status, errorCode: "PROVIDER_POLL" }); return; }
  const status = outcome.value;
  if (status.status === "completed") commit(deps, owner, run, { status: "downloading", errorCode: null });
  else if (status.status === "failed") commit(deps, owner, run, { status: "failed", errorCode: `PROVIDER_FAILED:${status.code}`.slice(0, 200) });
  // A restarted provider/mock may report queued again: never move a running run backwards.
  else if (status.status === "running" || run.errorCode !== null) commit(deps, owner, run, { status: status.status === "running" ? "running" : run.status, errorCode: null });
}

/** Validates provider outputs against the request; mock may return its explicit 1×1 fixture. */
async function checkOutputs(deps: Dependencies, run: C.Run, outputs: ProviderOutput[]): Promise<{ output: ProviderOutput; width: number; height: number }[]> {
  if (!Array.isArray(outputs) || outputs.length !== run.compiled.parameters.num_images) throw new AppError("PROVIDER", "OUTPUT_COUNT");
  const size = run.compiled.parameters.image_size;
  return Promise.all(outputs.map(async output => {
    if (output.mime !== "image/png" || !(output.bytes instanceof Uint8Array) || output.bytes.length === 0 || output.bytes.length > C.Limits.uploadBytes) throw new AppError("PROVIDER", "OUTPUT_FORMAT");
    const info = await deps.imageInspector.inspect(output.bytes);
    if (info.mime !== "image/png" || info.pages !== 1 || info.width * info.height > C.Limits.uploadPixels) throw new AppError("PROVIDER", "OUTPUT_FORMAT");
    if (run.compiled.adapterId !== "mock-reference" && (info.width !== size.width || info.height !== size.height)) throw new AppError("PROVIDER", "OUTPUT_SIZE");
    return { output, width: info.width, height: info.height };
  }));
}

async function stepDownload(deps: Dependencies, owner: string, run: C.Run, adapter: ModelAdapter | undefined): Promise<void> {
  if (!adapter || !run.providerRequestId) { commit(deps, owner, run, { status: "download_failed", errorCode: adapter ? "MISSING_REQUEST_ID" : "ADAPTER_UNAVAILABLE" }); return; }
  const requestId = run.providerRequestId;
  const { outcome, leaseLost } = await external(deps, owner, async () => {
    const checked = await checkOutputs(deps, run, await adapter.download(requestId));
    // Blobs are written before the DB commit; an orphan blob after a failed commit is acceptable.
    return Promise.all(checked.map(async c => ({ ...c, stored: await deps.blobs.write(c.output.bytes, "png") })));
  });
  if (leaseLost) return;
  if (outcome.kind !== "ok") {
    const reason = outcome.kind === "timeout" ? "DOWNLOAD_TIMEOUT" : outcome.error instanceof AppError && outcome.error.code === "PROVIDER" && /^OUTPUT_/.test(outcome.error.message) ? outcome.error.message : "DOWNLOAD_FAILED";
    commit(deps, owner, run, { status: "download_failed", errorCode: reason });
    return;
  }
  try {
    // Media, candidates and `succeeded` land together or not at all; unique(run,index) blocks duplicates.
    commit(deps, owner, run, { status: "succeeded", errorCode: null }, (tx, now) => {
      outcome.value.forEach((item, index) => {
        const media = C.Media.parse({ id: deps.newId(), projectId: run.projectId, revision: 0, createdAt: now, ...item.stored, mime: "image/png", width: item.width, height: item.height, source: "generated", licenseNotes: `Generated via ${run.compiled.endpoint}` });
        tx.insert("media", media);
        tx.insert("candidates", C.Candidate.parse({ id: deps.newId(), projectId: run.projectId, revision: 0, createdAt: now, runId: run.id, index, mediaId: media.id, parentCandidateId: run.snapshot.parentCandidateId, seed: item.output.seed }));
      });
    });
  } catch {
    commit(deps, owner, run, { status: "download_failed", errorCode: "STORE_FAILED" });
  }
}

/** T06: docs/contracts.md#runs. Preserve signature; implement all listed invariants. */
export async function tickWorker(deps: Dependencies, owner: string): Promise<{ processedRunId: string | null }> {
  if (typeof owner !== "string" || !owner.trim() || owner.length > ownerMaxLength) throw new AppError("VALIDATION", "Invalid worker owner");
  const now = deps.now();
  if (!deps.repo.acquireLease(owner, now, later(now, C.Limits.leaseMs))) return { processedRunId: null };
  const run = deps.repo.list("runs").find(r => activeStatuses.has(r.status));
  if (!run) return { processedRunId: null };
  const adapter = deps.adapters.get(run.compiled.adapterId);
  switch (run.status) {
    case "draft": await stepDraft(deps, owner, run, adapter); break;
    // Found at the start of a tick, `submitting` belongs to a crashed/expired worker: never resubmit.
    case "submitting": commit(deps, owner, run, run.providerRequestId ? { status: "queued" } : { status: "submission_unknown", errorCode: "SUBMISSION_INTERRUPTED" }); break;
    case "queued": case "running": await stepPoll(deps, owner, run, adapter); break;
    case "downloading": await stepDownload(deps, owner, run, adapter); break;
    // download_failed / submission_unknown wait for an explicit user action.
    default: return { processedRunId: null };
  }
  return { processedRunId: run.id };
}
