import * as C from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { deleteProject, getProject, updateProject } from "@/application/services/projects";
export const runtime = "nodejs";
async function projectId(context: { params: Promise<{ id: string }> }) {
  const parsed = C.Id.safeParse((await context.params).id); if (!parsed.success) throw new AppError("VALIDATION", "Invalid ID");
  return parsed.data;
}
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  return getProject(getDependencies(), await projectId(context));
}); }
/** T17: edit title/budget with CAS. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const id = await projectId(context);
  return updateProject(getDependencies(), id, await readJson(request, C.UpdateProject));
}); }
/** T17: delete the project's records (body {expectedRevision}); blobs stay on disk. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => {
  guardOrigin(request);
  const id = await projectId(context);
  return deleteProject(getDependencies(), id, await readJson(request, C.DeleteProject));
}); }
