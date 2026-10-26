# ADR 004 — adapter inputs, cost consent and model control limits
Status: accepted.

Fix primary fal-ai/flux-2/edit and comparator fal-ai/flux-2. Reject unsupported masks and excess references before paid calls; baseline visibly omits image refs. Preview snapshots stable media IDs and exact nonsecret native parameters; transport binds temporary upload URLs at submit. Persisting temporary URLs is unnecessary for reproduction and risks leakage.

Use integer micro-USD + known/unknown discriminant. No undocumented price formula: live estimates start unknown and require explicit consent, finite budgets block unknown. Reserve estimated known cost, prefer known actual costs, never silently treat failures as free. One global active run; unknown submission/download failure retains slot until resolution. Provider settings and schema changes require contract review.

## Amendment 2026-10-26 (T07, user-approved)

@fal-ai/client 1.10.1 `queue.submit` passes its own per-request retry policy (up to 3 attempts on 429/5xx), which overrides a client-level `retry: { maxRetries: 0 }`. The SDK queue API therefore cannot guarantee "no automatic paid resubmission". The default fal transport submits with one direct POST to the official Queue REST API (`https://queue.fal.run/<endpoint>`, `redirect: "error"`, 30s timeout). 429/5xx/timeout/disconnect/unparseable responses are `SubmissionError("unknown")`; only clear refusals (400/401/403/404/422) are "rejected"; success requires a valid `request_id`. Upload/status/result keep using an instance-scoped SDK client (read-only or non-billable calls). The public `FalTransport` interface is unchanged. Trade-off: the submit request format is owned by this adapter and must be re-checked against fal docs when the SDK or API changes.

## Amendment 2026-10-26 (T13)

`external()`'s timeout raced the submit promise but did not stop it, so after timeout → `submission_unknown` → abandon, a still-pending reference upload could finish and start the paid POST. `ModelAdapter.submit` and `FalTransport.submit` now take a `SubmitContext { signal, mayPost }` (`src/application/ports.ts`). The runs service aborts the signal at the 30s deadline, on lease loss and when the attempt ends, and supplies `mayPost` as a synchronous DB check (lease held by this owner, run still `submitting` at the attempt revision). Adapters stop uploading once aborted and re-check right before the POST with no await in between; the default transport passes the signal to fetch. Infrastructure never reads the DB itself. Limits: an upload already in progress cannot be cancelled, and aborting a POST that already left neither cancels nor refunds it, so that case stays `submission_unknown` without resubmission. This is still "stop on ambiguity", not exactly-once.
