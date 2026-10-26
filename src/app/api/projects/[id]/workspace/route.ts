import { Id } from "@/contracts";
import { AppError } from "@/domain/errors";
import { getWorkspace } from "@/application/services/projects";
import { getDependencies } from "@/server/container";
import { respond } from "@/server/http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{id:string}> }) { return respond(async()=>{ const id=Id.safeParse((await context.params).id);if(!id.success)throw new AppError("VALIDATION","Invalid ID");return getWorkspace(getDependencies(),id.data); }); }
