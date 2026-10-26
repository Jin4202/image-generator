import { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies } from "../ports";
import { AppError } from "../../domain/errors";
import { createPreview } from "./previews";

const shape = C.PreviewInput.shape;
/** PreviewInput without parentCandidateId (taken from the URL); an edit instruction is required. Zod 4 cannot `.omit` a refined object. */
export const RefineInput = z.object({ sceneId: shape.sceneId, adapterId: shape.adapterId, outputCount: shape.outputCount, seed: shape.seed, edit: shape.edit.unwrap().unwrap() }).strict();

function parseId(id: string, label: string): string {
  const parsed = C.Id.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label}`);
  return parsed.data;
}

/** T08: docs/contracts.md#review. Preserve signature; implement all listed invariants. */
export async function saveReview(deps: Dependencies, candidateId: string, input: z.infer<typeof C.ReviewInput>): Promise<C.Review> {
  const id = parseId(candidateId, "candidate ID");
  const parsed = C.ReviewInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid review ratings");
  const ratings = parsed.data;
  return deps.repo.transaction(tx => {
    const candidate = tx.get("candidates", id);
    if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found");
    const run = tx.get("runs", candidate.runId);
    if (!run) throw new AppError("NOT_FOUND", "Candidate run not found");
    // Edits are judged on preserving untouched regions too; originals have nothing to preserve.
    const isEdit = run.snapshot.edit !== null;
    if (isEdit && ratings.preservation === null) throw new AppError("VALIDATION", "Edited candidates need a preservation score");
    if (!isEdit && ratings.preservation !== null) throw new AppError("VALIDATION", "Original candidates have no preservation score");
    // Append-only: a new review never replaces an earlier one; the latest createdAt/id is the current verdict.
    const review = C.Review.parse({ id: deps.newId(), projectId: candidate.projectId, revision: 0, createdAt: deps.now(), candidateId: candidate.id, ratings });
    tx.insert("reviews", review);
    return review;
  });
}

/** T08: docs/contracts.md#review. Preserve signature; implement all listed invariants. */
export async function getCandidate(deps: Dependencies, id: string): Promise<{ candidate: C.Candidate; reviews: C.Review[] }> {
  const candidateId = parseId(id, "candidate ID");
  return deps.repo.transaction(tx => {
    const candidate = tx.get("candidates", candidateId);
    if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found");
    // Repository lists are already ordered by createdAt, then id.
    return { candidate, reviews: tx.list("reviews", candidate.projectId).filter(r => r.candidateId === candidate.id) };
  });
}

/** T08: docs/contracts.md#review. Preserve signature; implement all listed invariants. */
export async function refineCandidate(deps: Dependencies, candidateId: string, input: Omit<C.PreviewInput, "parentCandidateId">): Promise<C.Preview> {
  const parentCandidateId = parseId(candidateId, "candidate ID");
  const supplied = (input as { parentCandidateId?: unknown } | null)?.parentCandidateId;
  if (supplied !== undefined && supplied !== parentCandidateId) throw new AppError("VALIDATION", "The parent candidate comes from the URL");
  const { parentCandidateId: _ignored, ...rest } = (input ?? {}) as C.PreviewInput;
  void _ignored;
  const parsed = RefineInput.safeParse(rest);
  if (!parsed.success) throw new AppError("VALIDATION", "Refine needs a scene, adapter and edit instruction");
  if (!deps.repo.get("candidates", parentCandidateId)) throw new AppError("NOT_FOUND", "Candidate not found");
  // Only a preview is created: no run, no provider call, no cost. The caller submits it like any other preview.
  return createPreview(deps, { ...parsed.data, parentCandidateId });
}
