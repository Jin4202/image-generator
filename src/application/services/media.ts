import * as C from "../../contracts";
import type { Dependencies } from "../ports";
import { AppError } from "../../domain/errors";

const extensions = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;
type AcceptedMime = keyof typeof extensions;
const accepted = (mime: string): mime is AcceptedMime => Object.hasOwn(extensions, mime);

/** T02: docs/contracts.md#media. Project → decode → blob → DB; original bytes are stored unchanged. */
export async function uploadMedia(deps: Dependencies, input: { projectId: string; bytes: Uint8Array; declaredMime: string; licenseNotes: string }): Promise<C.Media> {
  const projectId = C.Id.safeParse(input?.projectId);
  if (!projectId.success) throw new AppError("VALIDATION", "Invalid projectId");
  if (!(input.bytes instanceof Uint8Array)) throw new AppError("VALIDATION", "Upload bytes required");
  if (typeof input.declaredMime !== "string") throw new AppError("VALIDATION", "Declared MIME type required");
  if (typeof input.licenseNotes !== "string" || input.licenseNotes.length > 2000) throw new AppError("VALIDATION", "licenseNotes must be at most 2000 characters");
  if (!deps.repo.get("projects", projectId.data)) throw new AppError("NOT_FOUND", "Project not found");
  // Copy once so the decoded and stored bytes are the same snapshot, whatever the caller does with its buffer.
  const bytes = new Uint8Array(input.bytes);
  if (bytes.length === 0) throw new AppError("INVALID_MEDIA", "Empty file");
  if (bytes.length > C.Limits.uploadBytes) throw new AppError("TOO_LARGE", "File exceeds 10 MiB");
  const declaredMime = input.declaredMime.trim().toLowerCase();
  if (!accepted(declaredMime)) throw new AppError("UNSUPPORTED", "Only PNG, JPEG and WebP images are accepted");
  let info;
  try { info = await deps.imageInspector.inspect(bytes); }
  catch (error) { throw error instanceof AppError && error.code !== "INTERNAL" ? error : new AppError("INVALID_MEDIA", "Image could not be decoded"); }
  if (info.mime !== declaredMime) throw new AppError("INVALID_MEDIA", "File content does not match its declared type");
  if (info.width * info.height > C.Limits.uploadPixels) throw new AppError("TOO_LARGE", "Image exceeds 16 megapixels");
  if (info.pages !== 1) throw new AppError("UNSUPPORTED", "Animated or multi-page images are not supported");
  const stored = await deps.blobs.write(bytes, extensions[declaredMime]);
  const media = C.Media.parse({ id: deps.newId(), projectId: projectId.data, revision: 0, createdAt: deps.now(), ...stored, mime: declaredMime, width: info.width, height: info.height, source: "upload", licenseNotes: input.licenseNotes });
  deps.repo.insert("media", media);
  return media;
}

/** T02: docs/contracts.md#media. Missing or inconsistent files surface as STORAGE, unknown IDs as NOT_FOUND. */
export async function readMedia(deps: Dependencies, id: string): Promise<{ media: C.Media; bytes: Uint8Array }> {
  const parsed = C.Id.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid media ID");
  const media = deps.repo.get("media", parsed.data);
  if (!media) throw new AppError("NOT_FOUND", "Media not found");
  let bytes: Uint8Array;
  try { bytes = await deps.blobs.read(media.relativePath); }
  catch (error) { throw error instanceof AppError && error.code === "STORAGE" ? error : new AppError("STORAGE", "Media file unavailable"); }
  if (bytes.length !== media.bytes) throw new AppError("STORAGE", "Media file does not match its record");
  return { media, bytes };
}
