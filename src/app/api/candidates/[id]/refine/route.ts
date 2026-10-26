import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { RefineInput, refineCandidate } from "@/application/services/review";
export const runtime = "nodejs";
/** T08: validate PreviewInput.omit({parentCandidateId:true}), parent from URL; return preview only. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  const input = await readJson(request, RefineInput);
  return refineCandidate(getDependencies(), parsed.data, input);
}); }
