// T08 normal/error/boundary cases: append-only reviews, edit preservation rule, refine → child lineage, candidate routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../src/application/ports";
import { getCandidate, refineCandidate, saveReview } from "../../src/application/services/review";
import { getRun, submitRun, tickWorker } from "../../src/application/services/runs";
import type { Candidate, ReviewInput } from "../../src/contracts";
import { passesReview } from "../../src/domain/approval";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { ids, now, sceneInput } from "../support/fixtures";
import { seedCandidate } from "../support/seed-candidate";
import { world } from "../support/world";
import type { z } from "zod";

// Composition root is T12. Route tests inject the real T01–T08 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const candidateRoute = await import("../../src/app/api/candidates/[id]/route");
const reviewRoute = await import("../../src/app/api/candidates/[id]/review/route");
const refineRoute = await import("../../src/app/api/candidates/[id]/refine/route");

type Ratings = z.infer<typeof ReviewInput>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const good: Ratings = { identity: 4, style: 4, composition: 4, anatomy: 3, preservation: null, approved: true, notes: "" };
const edit = { instruction: "fix the blade", preservation: "keep face and cloak", maskMediaId: null };
const refineInput = (patch: Record<string, unknown> = {}) => ({ sceneId: ids.scene, adapterId: "mock-reference" as const, outputCount: 1, seed: 2, edit, ...patch });

let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string; let seq: number;
beforeEach(async () => {
  w = world(); clock = now; seq = 2000;
  deps = { ...w.deps, blobs: createLocalBlobStore(w.root), now: () => clock, newId: () => id(seq++) }; container.deps = deps;
  await seedCandidate(deps);
});
afterEach(() => { container.deps = null; w.dispose(); });

/** Refine the seeded original, run it through the mock worker and return the child candidate. */
async function makeChild(): Promise<Candidate> {
  const preview = await refineCandidate(deps, ids.candidate, refineInput());
  const run = await submitRun(deps, { previewId: preview.id, previewHash: preview.hash, idempotencyKey: id(9000), acceptUnknownCost: false, maxEstimatedCostMicros: 0 });
  for (let i = 0; i < 6; i++) await tickWorker(deps, "w");
  const { candidates } = await getRun(deps, run.id);
  expect(candidates).toHaveLength(1);
  return candidates[0];
}

describe("saveReview / getCandidate", () => {
  it("appends reviews in time order; the latest createdAt/id is the current verdict", async () => {
    const first = await saveReview(deps, ids.candidate, { ...good, notes: "first" });
    clock = at(1000); const second = await saveReview(deps, ids.candidate, { ...good, approved: false, notes: "second" });
    expect(first).toMatchObject({ candidateId: ids.candidate, projectId: ids.project, revision: 0, createdAt: now, ratings: { notes: "first" } });
    const { candidate, reviews } = await getCandidate(deps, ids.candidate);
    expect(reviews.map(r => r.id)).toEqual([first.id, second.id]);
    expect(reviews.at(-1)?.ratings.approved).toBe(false);
    expect(deps.repo.get("reviews", first.id)).toEqual(first);
    expect(candidate).toEqual(deps.repo.get("candidates", ids.candidate));
  });
  it("records approved reviews below the threshold, which passesReview marks as failing", async () => {
    const low = await saveReview(deps, ids.candidate, { ...good, anatomy: 2 });
    expect(low.ratings.approved).toBe(true);
    expect(passesReview(low.ratings, false)).toBe(false);
    expect(passesReview((await saveReview(deps, ids.candidate, good)).ratings, false)).toBe(true);
  });
  it("forbids a preservation score on originals and requires one on edits", async () => {
    expect(await rejection(saveReview(deps, ids.candidate, { ...good, preservation: 4 }))).toBe("VALIDATION");
    const child = await makeChild();
    expect(await rejection(saveReview(deps, child.id, good))).toBe("VALIDATION");
    const review = await saveReview(deps, child.id, { ...good, preservation: 4 });
    expect(passesReview(review.ratings, true)).toBe(true);
    expect(passesReview((await saveReview(deps, child.id, { ...good, preservation: 3 })).ratings, true)).toBe(false);
  });
  it("rejects out-of-range ratings, unknown fields, unknown and malformed candidates", async () => {
    expect(await rejection(saveReview(deps, ids.candidate, { ...good, identity: 6 }))).toBe("VALIDATION");
    expect(await rejection(saveReview(deps, ids.candidate, { ...good, notes: "x".repeat(2001) }))).toBe("VALIDATION");
    expect(await rejection(saveReview(deps, ids.candidate, { ...good, score: 5 } as Ratings))).toBe("VALIDATION");
    expect(await rejection(saveReview(deps, id(999), good))).toBe("NOT_FOUND");
    expect(await rejection(getCandidate(deps, id(999)))).toBe("NOT_FOUND");
    expect(await rejection(getCandidate(deps, "nope"))).toBe("VALIDATION");
    expect(deps.repo.list("reviews", ids.project)).toEqual([]);
  });
  it("keeps each candidate's reviews separate", async () => {
    const child = await makeChild();
    await saveReview(deps, ids.candidate, good); await saveReview(deps, child.id, { ...good, preservation: 5 });
    expect((await getCandidate(deps, ids.candidate)).reviews.map(r => r.candidateId)).toEqual([ids.candidate]);
    expect((await getCandidate(deps, child.id)).reviews.map(r => r.candidateId)).toEqual([child.id]);
  });
});

describe("refineCandidate", () => {
  it("returns only a preview with the parent first; no run, no provider call, parent untouched", async () => {
    const submit = vi.fn(); deps = { ...deps, adapters: new Map([["mock-reference", { id: "mock-reference", submit, poll: vi.fn(), download: vi.fn() }]]) };
    const parent = deps.repo.get("candidates", ids.candidate); const media = deps.repo.get("media", ids.media)!;
    const bytes = await deps.blobs.read(media.relativePath);
    const preview = await refineCandidate(deps, ids.candidate, refineInput());
    expect(preview.snapshot).toMatchObject({ parentCandidateId: ids.candidate, edit });
    expect(preview.compiled.references[0]).toEqual({ mediaId: ids.media, role: "parent", note: "" });
    expect(preview.compiled.warnings).toContain("FULL_IMAGE_EDIT");
    expect(preview.compiled.estimate).toMatchObject({ kind: "known", micros: 0 });
    expect(deps.repo.list("runs", ids.project)).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
    expect(deps.repo.get("candidates", ids.candidate)).toEqual(parent);
    expect(deps.repo.get("media", ids.media)).toEqual(media); expect(await deps.blobs.read(media.relativePath)).toEqual(bytes);
  });
  it("produces a child candidate linked by parentCandidateId and run.snapshot.edit without changing the parent", async () => {
    const parentRun = structuredClone(deps.repo.get("runs", ids.run)); const parent = structuredClone(deps.repo.get("candidates", ids.candidate));
    const child = await makeChild();
    expect(child.parentCandidateId).toBe(ids.candidate);
    const childRun = deps.repo.get("runs", child.runId)!;
    expect(childRun.snapshot.edit).toEqual(edit); expect(childRun.snapshot.parentCandidateId).toBe(ids.candidate);
    expect(child.mediaId).not.toBe(ids.media);
    expect(deps.repo.get("candidates", ids.candidate)).toEqual(parent); expect(deps.repo.get("runs", ids.run)).toEqual(parentRun);
  });
  it("rejects missing edits, masks, other scenes, text baselines and conflicting parent ids", async () => {
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ edit: null }) as never))).toBe("VALIDATION");
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ edit: { ...edit, instruction: "  " } }) as never))).toBe("VALIDATION");
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ edit: { ...edit, maskMediaId: ids.media } }) as never))).toBe("UNSUPPORTED");
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ adapterId: "fal-flux2-text" }) as never))).toBe("UNSUPPORTED");
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ parentCandidateId: id(77) }) as never))).toBe("VALIDATION");
    const { createScene } = await import("../../src/application/services/scenes");
    const other = await createScene(deps, { projectId: ids.project, content: structuredClone(sceneInput.content) });
    expect(await rejection(refineCandidate(deps, ids.candidate, refineInput({ sceneId: other.id }) as never))).toBe("VALIDATION");
    expect(await rejection(refineCandidate(deps, id(999), refineInput() as never))).toBe("NOT_FOUND");
    expect(deps.repo.list("previews", ids.project).map(p => p.id)).toEqual([ids.preview]);
  });
});

describe("candidate routes", () => {
  const url = `http://127.0.0.1:3000/api/candidates/${ids.candidate}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (value = ids.candidate) => ({ params: Promise.resolve({ id: value }) });
  it("reads candidates, saves reviews and returns refine previews", async () => {
    const saved = await reviewRoute.POST(post("/review", good), ctx());
    expect(saved.status).toBe(200);
    const read = await (await candidateRoute.GET(new Request(url), ctx())).json();
    expect(read.data.reviews).toHaveLength(1); expect(read.data.candidate.id).toBe(ids.candidate);
    const refined = await refineRoute.POST(post("/refine", refineInput()), ctx());
    expect(refined.status).toBe(200); expect((await refined.json()).data.snapshot.parentCandidateId).toBe(ids.candidate);
  });
  it("maps errors to contract status codes", async () => {
    expect((await reviewRoute.POST(post("/review", { ...good, preservation: 4 }), ctx())).status).toBe(400);
    expect((await reviewRoute.POST(post("/review", good), ctx(id(999)))).status).toBe(404);
    expect((await refineRoute.POST(post("/refine", { ...refineInput(), parentCandidateId: ids.candidate }), ctx())).status).toBe(400);
    expect((await refineRoute.POST(post("/refine", refineInput({ edit: { ...edit, maskMediaId: ids.media } })), ctx())).status).toBe(422);
    expect((await refineRoute.POST(post("/refine", refineInput(), { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect((await candidateRoute.GET(new Request(url), ctx("bad"))).status).toBe(400);
  });
});
