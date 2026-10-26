import { DemoInput, runDemo } from "../../../server/demo";
import { guardOrigin, readJson, respond } from "../../../server/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => { guardOrigin(request); return runDemo(await readJson(request, DemoInput)); }); }
