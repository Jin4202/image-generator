import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { getScene } from "@/application/services/scenes";
import { updateScene } from "@/application/services/scenes";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  return getScene(getDependencies() ,parsed.data);
}); }
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  const input = await readJson(request, C.UpdateScene);
  return updateScene(getDependencies() ,parsed.data, input);
}); }
