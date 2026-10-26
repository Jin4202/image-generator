import { Limits } from "@/contracts";
import { AppError } from "@/domain/errors";
import { getDependencies } from "@/server/container";
import { guardOrigin, respond } from "@/server/http";
import { uploadMedia } from "@/application/services/media";
export const runtime = "nodejs";
const bodyLimit = Limits.uploadBytes + 64 * 1024;
const fields = ["file", "projectId", "licenseNotes"];

/** Count the stream before parsing so an oversized body is never fully buffered, with or without Content-Length. */
async function readBounded(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > bodyLimit) throw new AppError("TOO_LARGE", "Upload body exceeds limit");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("VALIDATION", "Multipart body required");
  const parts: Uint8Array[] = []; let size = 0;
  while (true) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.length;
    if (size > bodyLimit) { await reader.cancel(); throw new AppError("TOO_LARGE", "Upload body exceeds limit"); }
    parts.push(item.value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** T02: bounded multipart upload; see HTTP media contract. */
export async function POST(request: Request) { return respond(async () => {
  guardOrigin(request);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new AppError("VALIDATION", "Expected multipart/form-data");
  const body = await readBounded(request);
  let form: FormData;
  try { form = await new Response(body, { headers: { "content-type": contentType } }).formData(); }
  catch { throw new AppError("VALIDATION", "Malformed multipart body"); }
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (!fields.includes(key)) throw new AppError("VALIDATION", "Unexpected upload field");
    if (seen.has(key)) throw new AppError("VALIDATION", "Duplicate upload field");
    seen.add(key);
  }
  const file = form.get("file"); const projectId = form.get("projectId"); const licenseNotes = form.get("licenseNotes") ?? "";
  if (!(file instanceof File)) throw new AppError("VALIDATION", "A single file field is required");
  if (typeof projectId !== "string" || typeof licenseNotes !== "string") throw new AppError("VALIDATION", "projectId and licenseNotes must be text fields");
  if (file.size > Limits.uploadBytes) throw new AppError("TOO_LARGE", "File exceeds 10 MiB");
  return uploadMedia(getDependencies(), { projectId, bytes: new Uint8Array(await file.arrayBuffer()), declaredMime: file.type, licenseNotes });
}); }
