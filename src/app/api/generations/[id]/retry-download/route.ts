import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, respond } from "@/server/http";
import { retryDownload } from "@/application/services/runs";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  return retryDownload(getDependencies() ,parsed.data);
}); }
