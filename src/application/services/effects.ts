import type { z } from "zod";
import * as C from "../../contracts";
import type { Dependencies, UnitOfWork } from "../ports";
import { AppError } from "../../domain/errors";
import { getWorkspace } from "./projects";

type EffectsContent = z.infer<typeof C.EffectsInput>;
const identity: Omit<EffectsContent, "expectedRevision"> = { layers: [], brightness: 1, contrast: 1, saturation: 1, blur: 0 };

function parseId(id: string, label: string): string {
  const parsed = C.Id.safeParse(id);
  if (!parsed.success) throw new AppError("VALIDATION", `Invalid ${label}`);
  return parsed.data;
}
function candidateOf(tx: UnitOfWork, id: string): C.Candidate {
  const candidate = tx.get("candidates", id);
  if (!candidate) throw new AppError("NOT_FOUND", "Candidate not found");
  return candidate;
}
const effectsOf = (tx: UnitOfWork, candidate: C.Candidate) => tx.list("effects", candidate.projectId).find(e => e.candidateId === candidate.id) ?? null;
function mediaIn(tx: UnitOfWork, projectId: string, mediaId: string): C.Media {
  const media = tx.get("media", mediaId);
  if (!media || media.projectId !== projectId) throw new AppError("NOT_FOUND", "Media not found");
  return media;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * T15: reads and checks every media the manifest will list (plus the render inputs) before anything is written.
 * Each record must match its file: byte count, SHA-256 and the decoded MIME/size. Any mismatch is STORAGE without
 * paths or raw errors. Files shared by several records are read and decoded once; each record is still compared.
 * Runs outside any DB transaction. Returns the verified bytes by relative path.
 */
async function verifyMediaFiles(deps: Dependencies, media: readonly C.Media[]): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Promise<{ bytes: Uint8Array; sha256: string; info: Awaited<ReturnType<Dependencies["imageInspector"]["inspect"]>> } | null>>();
  const load = (path: string) => {
    let pending = files.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const bytes = await deps.blobs.read(path);
          return { bytes, sha256: await sha256Hex(bytes), info: await deps.imageInspector.inspect(bytes) };
        } catch { return null; }
      })();
      files.set(path, pending);
    }
    return pending;
  };
  const checked = await Promise.all(media.map(async m => ({ m, file: await load(m.relativePath) })));
  for (const { m, file } of checked) {
    if (!file) throw new AppError("STORAGE", "A referenced media file is missing or unreadable");
    if (file.bytes.length !== m.bytes || file.sha256 !== m.sha256 || file.info.mime !== m.mime || file.info.width !== m.width || file.info.height !== m.height) throw new AppError("STORAGE", "A referenced media file does not match its record");
  }
  return new Map(checked.map(({ m, file }) => [m.relativePath, file!.bytes]));
}

/** T09: docs/contracts.md#effects. Preserve signature; implement all listed invariants. */
export async function saveEffects(deps: Dependencies, candidateId: string, input: z.infer<typeof C.EffectsInput>): Promise<C.Effects> {
  const id = parseId(candidateId, "candidate ID");
  const parsed = C.EffectsInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid effects");
  const content = parsed.data;
  return deps.repo.transaction(tx => {
    const candidate = candidateOf(tx, id);
    for (const layer of content.layers) mediaIn(tx, candidate.projectId, layer.mediaId);
    const current = effectsOf(tx, candidate);
    // First save expects 0 and creates revision 0; later saves expect the stored Effects.revision.
    if ((current?.revision ?? 0) !== content.expectedRevision) throw new AppError("CONFLICT", "Effects were changed by another save; reload and retry");
    if (!current) {
      const created = C.Effects.parse({ id: deps.newId(), projectId: candidate.projectId, revision: 0, createdAt: deps.now(), candidateId: candidate.id, content });
      tx.insert("effects", created);
      return created;
    }
    const next = { ...current, revision: current.revision + 1, content };
    tx.replace("effects", next, current.revision);
    return next;
  });
}

/** T09: docs/contracts.md#effects. Preserve signature; implement all listed invariants. */
export async function getEffects(deps: Dependencies, candidateId: string): Promise<C.Effects | null> {
  const id = parseId(candidateId, "candidate ID");
  return deps.repo.transaction(tx => effectsOf(tx, candidateOf(tx, id)));
}

/** T09: docs/contracts.md#effects. Preserve signature; implement all listed invariants. */
export async function exportCandidate(deps: Dependencies, input: z.infer<typeof C.ExportInput>): Promise<C.ExportRecord> {
  const parsed = C.ExportInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid export request");
  const { candidate, base, effects, overlays } = deps.repo.transaction(tx => {
    const candidate = candidateOf(tx, parsed.data.candidateId);
    const effects = effectsOf(tx, candidate);
    const content = effects?.content ?? { ...identity, expectedRevision: 0 };
    // Draw order: low zIndex first, ties keep array order.
    const ordered = content.layers.map((layer, i) => ({ layer, i })).sort((a, b) => a.layer.zIndex - b.layer.zIndex || a.i - b.i).map(({ layer }) => layer);
    return { candidate, base: mediaIn(tx, candidate.projectId, candidate.mediaId), effects, overlays: ordered.map(layer => ({ layer, media: mediaIn(tx, candidate.projectId, layer.mediaId) })) };
  });
  const content = effects?.content ?? identity;
  // Manifest snapshot is the workspace immediately before this export's PNG media and record exist; it stays fixed from here.
  const workspace = await getWorkspace(deps, candidate.projectId);

  // All file work happens before the DB commit; any failure here leaves the database untouched.
  const verified = await verifyMediaFiles(deps, [...workspace.media, base, ...overlays.map(o => o.media)]);
  const bytesOf = (media: C.Media) => verified.get(media.relativePath)!;
  const rendered = await deps.imageCompositor.composite({
    base: bytesOf(base),
    adjustments: { brightness: content.brightness, contrast: content.contrast, saturation: content.saturation, blur: content.blur },
    overlays: overlays.map(({ layer, media }) => ({ bytes: bytesOf(media), layer })),
  });
  const png = await deps.blobs.write(rendered.bytes, "png");
  const exportedAt = deps.now();
  const manifest = C.Manifest.parse({
    schemaVersion: 1, exportedAt, candidateId: candidate.id, workspace,
    files: workspace.media.map(m => ({ mediaId: m.id, path: m.relativePath, sha256: m.sha256 })),
  });
  const manifestBlob = await deps.blobs.write(new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), "json");

  return deps.repo.transaction(tx => {
    // Re-check what the render depended on; a concurrent change means the files would not match the record.
    const currentBase = tx.get("media", base.id);
    const currentEffects = effectsOf(tx, candidateOf(tx, candidate.id));
    if (!currentBase || currentBase.sha256 !== base.sha256 || (currentEffects?.revision ?? null) !== (effects?.revision ?? null)) throw new AppError("CONFLICT", "Candidate effects or source changed during export; export again");
    const media = C.Media.parse({ id: deps.newId(), projectId: candidate.projectId, revision: 0, createdAt: exportedAt, ...png, mime: "image/png", width: rendered.width, height: rendered.height, source: "export", licenseNotes: `Export of candidate ${candidate.id}` });
    tx.insert("media", media);
    const record = C.ExportRecord.parse({ id: deps.newId(), projectId: candidate.projectId, revision: 0, createdAt: exportedAt, candidateId: candidate.id, pngMediaId: media.id, manifestPath: manifestBlob.relativePath, manifestVersion: 1 });
    tx.insert("exports", record);
    return record;
  });
}

/** T09: manifest JSON bytes for an export record ID (download route); paths are never accepted from clients. */
export async function readExportManifest(deps: Dependencies, exportId: string): Promise<{ record: C.ExportRecord; bytes: Uint8Array }> {
  const record = deps.repo.get("exports", parseId(exportId, "export ID"));
  if (!record) throw new AppError("NOT_FOUND", "Export not found");
  let bytes: Uint8Array;
  try { bytes = await deps.blobs.read(record.manifestPath); }
  catch { throw new AppError("STORAGE", "Manifest file is missing or changed"); }
  return { record, bytes };
}
