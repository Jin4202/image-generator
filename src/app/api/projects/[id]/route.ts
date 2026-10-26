import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { respond } from "@/server/http";
import { getProject } from "@/application/services/projects";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  return getProject(getDependencies() ,parsed.data);
}); }
