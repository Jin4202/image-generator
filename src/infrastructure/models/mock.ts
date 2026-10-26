import { randomUUID } from "node:crypto";
import type { ModelAdapter, ProviderOutput, ProviderStatus } from "../../application/ports";
import { Compiled } from "../../contracts";
import { AppError } from "../../domain/errors";
// 1x1 PNG fixture: transport test only, NOT artwork or requested dimensions.
export const MOCK_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMw2rLgPwAFKAKGnFz99AAAAABJRU5ErkJggg==";
export class MockAdapter implements ModelAdapter {
  readonly id = "mock-reference" as const;
  private polls = new Map<string, number>();
  constructor(private readonly outcome: "success" | "failure" = "success") {}
  async submit(input: Compiled, references: readonly Uint8Array[]) {
    Compiled.parse(input);
    if (input.adapterId !== this.id || references.length !== input.references.length || references.length > 4) throw new AppError("VALIDATION", "Mock reference mapping mismatch");
    return { requestId: `mock:${randomUUID()}:${input.parameters.num_images}:${input.parameters.seed ?? "none"}:${this.outcome}` };
  }
  private decode(requestId: string) {
    const m=/^mock:[a-f0-9-]{36}:([1-4]):(none|[0-9]+):(success|failure)$/.exec(requestId);
    if (!m) throw new AppError("NOT_FOUND", "Unknown mock request");
    return { count: Number(m[1]), seed: m[2] === "none" ? null : Number(m[2]), outcome: m[3] };
  }
  async poll(requestId: string): Promise<ProviderStatus> {
    const job=this.decode(requestId);const count=(this.polls.get(requestId) ?? 0)+1;this.polls.set(requestId,count);
    if (count === 1) return { status: "queued" };
    if (count === 2) return { status: "running" };
    return job.outcome === "failure" ? { status: "failed", code: "MOCK_FAILURE" } : { status: "completed" };
  }
  async download(requestId: string): Promise<ProviderOutput[]> {
    const job=this.decode(requestId);
    if (job.outcome === "failure") throw new AppError("PROVIDER", "Mock failure has no output");
    return Array.from({length:job.count},()=>({bytes:new Uint8Array(Buffer.from(MOCK_PNG_BASE64,"base64")),mime:"image/png",seed:job.seed}));
  }
}
