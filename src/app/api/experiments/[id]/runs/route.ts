import { z } from "zod";
import { Id } from "@/contracts";
import { AppError } from "@/domain/errors";
import { attachExperimentRun } from "@/application/services/experiments";
import { getDependencies } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: {params:Promise<{id:string}>}) {return respond(async()=>{guardOrigin(request);const id=Id.safeParse((await context.params).id);if(!id.success)throw new AppError("VALIDATION","Invalid ID");const input=await readJson(request,z.object({runId:Id}).strict());return attachExperimentRun(getDependencies(),id.data,input.runId);});}
