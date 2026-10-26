import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { resolveRun } from "@/application/services/runs";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  const input = await readJson(request, C.ResolveInput);
  return resolveRun(getDependencies() ,parsed.data, input);
}); }
