// T15: export verifies every media the manifest lists (not only the render inputs) before writing anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dependencies } from "../../src/application/ports";
import { exportCandidate, readExportManifest } from "../../src/application/services/effects";
import { Manifest, type Media } from "../../src/contracts";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { compiled, ids, now, snapshot } from "../support/fixtures";
import { world } from "../support/world";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const solid = async (width: number, height: number, rgb: [number, number, number]) => new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
const failure = async (work: Promise<unknown>) => { try { await work; return { code: "no error", message: "" }; } catch (error) { return { code: (error as { code?: string }).code ?? "raw", message: String((error as Error).message) }; } };

let w: ReturnType<typeof world>; let deps: Dependencies; let seq: number;
const insertImage = async (n: number, bytes: Uint8Array, patch: Partial<Media> = {}) => {
  const stored = await deps.blobs.write(bytes, "png"); const meta = await sharp(Buffer.from(bytes)).metadata();
  deps.repo.insert("media", { id: id(n), projectId: ids.project, revision: 0, createdAt: now, ...stored, mime: "image/png", width: meta.width!, height: meta.height!, source: "upload", licenseNotes: "", ...patch });
  return deps.repo.get("media", id(n))!;
};
const counts = () => ({ media: deps.repo.list("media", ids.project).length, exports: deps.repo.list("exports", ids.project).length, blobs: readdirSync(join(w.root, "blobs")).length });
const fileOf = (media: Media) => join(w.root, media.relativePath);

beforeEach(async () => {
  w = world(); seq = 3000;
  deps = { ...w.deps, blobs: createLocalBlobStore(w.root), newId: () => id(seq++) };
  const base = await insertImage(10, await solid(16, 12, [120, 60, 30]));
  w.seedPreview();
  deps.repo.insert("runs", { id: ids.run, projectId: ids.project, revision: 0, createdAt: now, previewId: ids.preview, idempotencyKey: ids.run, status: "succeeded", snapshot, compiled, providerRequestId: "seed", actualCost: { kind: "unknown", reason: "test" }, errorCode: null, updatedAt: now });
  deps.repo.insert("candidates", { id: ids.candidate, projectId: ids.project, revision: 0, createdAt: now, runId: ids.run, index: 0, mediaId: base.id, parentCandidateId: null, seed: 1 });
});
afterEach(() => { vi.restoreAllMocks(); w.dispose(); });

/** Asserts the export fails with STORAGE, leaks no path, and commits/writes nothing. */
async function expectRefused() {
  const before = counts();
  const result = await failure(exportCandidate(deps, { candidateId: ids.candidate }));
  expect(result.code).toBe("STORAGE");
  for (const leak of [w.root, "blobs/", ".png"]) expect(result.message).not.toContain(leak);
  expect(counts()).toEqual(before);
}

describe("manifest reference integrity", () => {
  it("a missing media that is neither base nor overlay fails the export with nothing committed", async () => {
    const unrelated = await insertImage(20, await solid(4, 4, [0, 200, 0]));
    rmSync(fileOf(unrelated));
    await expectRefused();
  });
  it("same-length byte tampering is caught by the hash", async () => {
    const unrelated = await insertImage(20, await solid(4, 4, [0, 200, 0]));
    const bytes = readFileSync(fileOf(unrelated)); bytes[bytes.length - 20] ^= 0xff;
    rmSync(fileOf(unrelated)); writeFileSync(fileOf(unrelated), bytes);
    expect(readFileSync(fileOf(unrelated)).length).toBe(unrelated.bytes);
    await expectRefused();
  });
  it.each([
    ["byte count", { bytes: 1 }],
    ["MIME", { mime: "image/jpeg" as const }],
    ["width", { width: 5 }],
    ["height", { height: 5 }],
  ])("a %s mismatch between the record and its file fails", async (_label, patch) => {
    await insertImage(20, await solid(4, 4, [0, 200, 0]), patch);
    await expectRefused();
  });
  it("an undecodable file whose size and hash match its record still fails (decode check)", async () => {
    const garbage = new TextEncoder().encode("not an image at all, but hashed honestly");
    const stored = await deps.blobs.write(garbage, "png");
    deps.repo.insert("media", { id: id(20), projectId: ids.project, revision: 0, createdAt: now, ...stored, mime: "image/png", width: 4, height: 4, source: "upload", licenseNotes: "" });
    await expectRefused();
  });
  it("two records sharing one file: read once, but each record is compared", async () => {
    const shared = await insertImage(20, await solid(4, 4, [0, 200, 0]));
    deps.repo.insert("media", { ...shared, id: id(21) });
    const read = vi.spyOn(deps.blobs, "read");
    const record = await exportCandidate(deps, { candidateId: ids.candidate });
    expect(read.mock.calls.filter(([path]) => path === shared.relativePath)).toHaveLength(1);
    expect(record.candidateId).toBe(ids.candidate);
    deps.repo.insert("media", { ...shared, id: id(22), width: 9 });
    await expectRefused();
  });
  it("a healthy snapshot exports with the unchanged manifest shape and untouched originals", async () => {
    const unrelated = await insertImage(20, await solid(4, 4, [0, 200, 0]));
    const original = readFileSync(fileOf(unrelated));
    const first = await exportCandidate(deps, { candidateId: ids.candidate });
    const second = await exportCandidate(deps, { candidateId: ids.candidate }); // the first export PNG is now verified too
    const manifest = Manifest.parse(JSON.parse(Buffer.from((await readExportManifest(deps, second.id)).bytes).toString("utf8")));
    expect(manifest.files).toEqual(manifest.workspace.media.map(m => ({ mediaId: m.id, path: m.relativePath, sha256: m.sha256 })));
    expect(manifest.workspace.media.map(m => m.id)).toEqual(expect.arrayContaining([id(10), unrelated.id, first.pngMediaId]));
    expect(manifest.workspace.media.map(m => m.id)).not.toContain(second.pngMediaId);
    expect(readFileSync(fileOf(unrelated)).equals(original)).toBe(true);
  });
  it("a corrupted earlier export PNG blocks the next export", async () => {
    const first = await exportCandidate(deps, { candidateId: ids.candidate });
    const png = deps.repo.get("media", first.pngMediaId)!;
    rmSync(fileOf(png)); writeFileSync(fileOf(png), await solid(16, 12, [1, 2, 3]));
    await expectRefused();
  });
});
