import { z } from "zod";
import { Limits } from "../contracts";
import { AppError, errorStatus } from "../domain/errors";
/** JSON only. Read body incrementally to enforce limit even without Content-Length. */
export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new AppError("VALIDATION", "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("VALIDATION", "JSON body required");
  const parts: Uint8Array[] = []; let size = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.length;
    if (size > Limits.jsonBytes) { await reader.cancel(); throw new AppError("TOO_LARGE", "JSON body exceeds limit"); }
    parts.push(item.value);
  }
  try { return schema.parse(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
  catch { throw new AppError("VALIDATION", "Invalid JSON or request fields"); }
}
export function guardOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  // Next may normalize Request.url to localhost while the browser uses 127.0.0.1.
  // Trust the direct Host header only after restricting it to loopback; no proxy headers.
  const host = request.headers.get("host") ?? url.host;
  let expected: URL;
  try { expected = new URL(`${url.protocol}//${host}`); }
  catch { throw new AppError("FORBIDDEN", "Invalid local host"); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname) || expected.host !== host.toLowerCase() || expected.username || expected.password || (origin && origin !== expected.origin)) {
    throw new AppError("FORBIDDEN", "Cross-origin or non-local mutation rejected");
  }
}
export async function respond(action: () => Promise<unknown>, status = 200): Promise<Response> {
  try { return Response.json({ data: await action() }, { status, headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    const e = error instanceof AppError ? error : new AppError("INTERNAL", "Internal server error");
    return Response.json({ error: { code: e.code, message: e.message } }, { status: errorStatus[e.code], headers: { "Cache-Control": "no-store" } });
  }
}
