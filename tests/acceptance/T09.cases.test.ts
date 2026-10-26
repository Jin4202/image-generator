// T09 normal/error/boundary cases: compositor semantics, effects CAS, export atomicity, manifest snapshot and routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dependencies } from "../../src/application/ports";
import { exportCandidate, getEffects, readExportManifest, saveEffects } from "../../src/application/services/effects";
import { cssFilter, rotatedBox, topLeftFromCenter } from "../../src/components/canvas/effects-canvas";
import { Manifest, type EffectsInput } from "../../src/contracts";
import { createSharpImageCompositor } from "../../src/infrastructure/images/compositor";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { compiled, ids, now, project, snapshot } from "../support/fixtures";
import { world } from "../support/world";
import type { z } from "zod";

// Composition root is T12. Route tests inject the real T01–T09 implementations through a container test double.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const effectsRoute = await import("../../src/app/api/candidates/[id]/effects/route");
const exportsRoute = await import("../../src/app/api/exports/route");
const manifestRoute = await import("../../src/app/api/exports/[id]/manifest/route");

type Effects = z.infer<typeof EffectsInput>;
type Rgba = [number, number, number, number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const solid = async (width: number, height: number, [r, g, b, a]: Rgba) => new Uint8Array(await sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: a / 255 } } }).png().toBuffer());
const pixels = async (bytes: Uint8Array) => { const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { at: (x: number, y: number): Rgba => { const i = (y * info.width + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; }, info, data }; };
const ident: Omit<Effects, "expectedRevision"> = { layers: [], brightness: 1, contrast: 1, saturation: 1, blur: 0 };
const adjust = (patch: Partial<Effects> = {}) => ({ brightness: 1, contrast: 1, saturation: 1, blur: 0, ...patch });
const layer = (mediaId: string, patch: Partial<Effects["layers"][number]> = {}) => ({ mediaId, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, zIndex: 0, blend: "source-over" as const, ...patch });

describe("sharp ImageCompositor", () => {
  const compositor = createSharpImageCompositor();
  it("reproduces base pixels exactly for identity with no overlays, including alpha", async () => {
    const base = new Uint8Array(await sharp(Buffer.from([10, 20, 30, 40, 200, 150, 100, 255, 0, 0, 0, 0, 255, 255, 255, 128]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
    const out = await compositor.composite({ base, adjustments: adjust(), overlays: [] });
    expect(out).toMatchObject({ width: 2, height: 2 });
    expect((await pixels(out.bytes)).data).toEqual((await pixels(base)).data);
  });
  it("applies brightness before contrast and keeps alpha", async () => {
    const base = await solid(4, 4, [100, 100, 100, 128]);
    const both = await pixels((await compositor.composite({ base, adjustments: adjust({ brightness: 2, contrast: 0.5 }), overlays: [] })).bytes);
    expect(both.at(0, 0)).toEqual([164, 164, 164, 128]); // (100·2)·0.5 + 64; the reverse order would give 228
    expect((await pixels((await compositor.composite({ base, adjustments: adjust({ contrast: 0.5 }), overlays: [] })).bytes)).at(1, 1)).toEqual([114, 114, 114, 128]);
    expect((await pixels((await compositor.composite({ base, adjustments: adjust({ brightness: 3 }), overlays: [] })).bytes)).at(2, 2)).toEqual([255, 255, 255, 128]);
  });
  it("desaturates and blurs RGB only; tiny blur uses sigma 0.3", async () => {
    const red = await solid(8, 8, [200, 40, 40, 255]);
    const [r, g, b] = (await pixels((await compositor.composite({ base: red, adjustments: adjust({ saturation: 0 }), overlays: [] })).bytes)).at(4, 4);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
    const half = await solid(8, 8, [10, 200, 10, 77]);
    const blurred = await pixels((await compositor.composite({ base: half, adjustments: adjust({ blur: 0.1 }), overlays: [] })).bytes);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(blurred.at(x, y)[3]).toBe(77);
  });
  it("places overlays by rounded top-left, clips at canvas edges, applies opacity and draws in the given order", async () => {
    const white = await solid(20, 20, [255, 255, 255, 255]); const red = await solid(10, 10, [255, 0, 0, 255]); const blue = await solid(10, 10, [0, 0, 255, 255]);
    const at = async (overlays: { bytes: Uint8Array; layer: { x: number; y: number; scale: number; rotation: number; opacity: number } }[]) => pixels((await compositor.composite({ base: white, adjustments: adjust(), overlays })).bytes);
    const L = (x: number, y: number, extra = {}) => ({ x, y, scale: 1, rotation: 0, opacity: 1, ...extra });
    const placed = await at([{ bytes: red, layer: L(5.4, 4.6) }]);
    expect(placed.at(5, 5)).toEqual([255, 0, 0, 255]); expect(placed.at(4, 5)).toEqual([255, 255, 255, 255]); expect(placed.at(15, 15)).toEqual([255, 255, 255, 255]);
    const clipped = await at([{ bytes: red, layer: L(-5, 15) }]);
    expect(clipped.at(0, 19)).toEqual([255, 0, 0, 255]); expect(clipped.at(5, 19)).toEqual([255, 255, 255, 255]); expect(clipped.info).toMatchObject({ width: 20, height: 20 });
    expect((await at([{ bytes: red, layer: L(100, 100) }])).data).toEqual((await pixels(white)).data);
    const faded = (await at([{ bytes: red, layer: L(0, 0, { opacity: 0.5 }) }])).at(2, 2);
    expect(faded[0]).toBe(255); expect(faded[1]).toBeGreaterThan(120); expect(faded[1]).toBeLessThan(135);
    expect((await at([{ bytes: red, layer: L(0, 0) }, { bytes: blue, layer: L(0, 0) }])).at(3, 3)).toEqual([0, 0, 255, 255]);
    const scaled = await at([{ bytes: red, layer: L(0, 0, { scale: 0.5 }) }]);
    expect(scaled.at(4, 4)).toEqual([255, 0, 0, 255]); expect(scaled.at(6, 6)).toEqual([255, 255, 255, 255]);
  });
  it("rotates clockwise about the overlay center into a larger bounding box", async () => {
    const white = await solid(30, 30, [255, 255, 255, 255]); const bar = await solid(10, 2, [0, 0, 0, 255]);
    const out = await pixels((await compositor.composite({ base: white, adjustments: adjust(), overlays: [{ bytes: bar, layer: { x: 0, y: 0, scale: 1, rotation: 90, opacity: 1 } }] })).bytes);
    expect(out.at(0, 5)).toEqual([0, 0, 0, 255]); expect(out.at(1, 9)).toEqual([0, 0, 0, 255]); expect(out.at(5, 0)).toEqual([255, 255, 255, 255]);
    expect(rotatedBox(10, 2, 1, 90).width).toBeCloseTo(2); expect(rotatedBox(10, 2, 1, 90).height).toBeCloseTo(10);
  });
  it("rejects undecodable inputs and oversized scaled overlays", async () => {
    const white = await solid(4, 4, [255, 255, 255, 255]);
    expect(await rejection(compositor.composite({ base: new TextEncoder().encode("nope"), adjustments: adjust(), overlays: [] }))).toBe("INVALID_MEDIA");
    expect(await rejection(compositor.composite({ base: white, adjustments: adjust(), overlays: [{ bytes: new Uint8Array([1, 2]), layer: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }] }))).toBe("INVALID_MEDIA");
    const big = await solid(4000, 4000, [0, 0, 0, 255]);
    expect(await rejection(compositor.composite({ base: white, adjustments: adjust(), overlays: [{ bytes: big, layer: { x: 0, y: 0, scale: 8, rotation: 0, opacity: 1 } }] }))).toBe("UNSUPPORTED");
  });
});

describe("effects and export services", () => {
  let w: ReturnType<typeof world>; let deps: Dependencies; let clock: string; let seq: number; let baseId: string;
  const insertImage = async (n: number, bytes: Uint8Array, projectId = ids.project) => {
    const stored = await deps.blobs.write(bytes, "png"); const meta = await sharp(Buffer.from(bytes)).metadata();
    deps.repo.insert("media", { id: id(n), projectId, revision: 0, createdAt: now, ...stored, mime: "image/png", width: meta.width!, height: meta.height!, source: "upload", licenseNotes: "" });
    return id(n);
  };
  beforeEach(async () => {
    w = world(); clock = now; seq = 3000;
    deps = { ...w.deps, blobs: createLocalBlobStore(w.root), now: () => clock, newId: () => id(seq++) }; container.deps = deps;
    baseId = await insertImage(10, await solid(16, 12, [120, 60, 30, 255]));
    w.seedPreview();
    deps.repo.insert("runs", { id: ids.run, projectId: ids.project, revision: 0, createdAt: now, previewId: ids.preview, idempotencyKey: ids.run, status: "succeeded", snapshot, compiled, providerRequestId: "seed", actualCost: { kind: "unknown", reason: "test" }, errorCode: null, updatedAt: now });
    deps.repo.insert("candidates", { id: ids.candidate, projectId: ids.project, revision: 0, createdAt: now, runId: ids.run, index: 0, mediaId: baseId, parentCandidateId: null, seed: 1 });
  });
  afterEach(() => { container.deps = null; w.dispose(); });

  it("creates effects at revision 0, then CAS-updates with Effects.revision and reloads identically", async () => {
    expect(await getEffects(deps, ids.candidate)).toBeNull();
    const first = await saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, brightness: 1.2 });
    expect(first).toMatchObject({ revision: 0, candidateId: ids.candidate, projectId: ids.project, content: { brightness: 1.2 } });
    const second = await saveEffects(deps, ids.candidate, { ...ident, expectedRevision: first.revision, contrast: 0.8 });
    expect(second.revision).toBe(1);
    expect(await rejection(saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0 }))).toBe("CONFLICT");
    expect(await getEffects(deps, ids.candidate)).toEqual(second);
  });
  it("validates candidates, overlay scope and ranges, leaving the source untouched", async () => {
    const source = deps.repo.get("media", baseId);
    deps.repo.insert("projects", { ...project, id: id(500), projectId: id(500), title: "Other" });
    const foreign = await insertImage(11, await solid(2, 2, [0, 0, 0, 255]), id(500));
    expect(await rejection(saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 1 }))).toBe("CONFLICT");
    expect(await rejection(saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, layers: [layer(foreign)] }))).toBe("NOT_FOUND");
    expect(await rejection(saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, blur: 21 }))).toBe("VALIDATION");
    expect(await rejection(saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, layers: [{ ...layer(baseId), blend: "multiply" as never }] }))).toBe("VALIDATION");
    expect(await rejection(saveEffects(deps, id(999), { ...ident, expectedRevision: 0 }))).toBe("NOT_FOUND");
    expect(await rejection(getEffects(deps, id(999)))).toBe("NOT_FOUND");
    expect(deps.repo.get("media", baseId)).toEqual(source); expect(deps.repo.list("effects", ids.project)).toEqual([]);
  });
  it("exports identity defaults when no effects exist, preserving pixels and the source", async () => {
    const source = deps.repo.get("media", baseId)!; const sourceBytes = await deps.blobs.read(source.relativePath);
    const record = await exportCandidate(deps, { candidateId: ids.candidate });
    const png = deps.repo.get("media", record.pngMediaId)!;
    expect(png).toMatchObject({ source: "export", mime: "image/png", width: 16, height: 12 });
    expect((await pixels(await deps.blobs.read(png.relativePath))).data).toEqual((await pixels(sourceBytes)).data);
    expect(deps.repo.get("media", baseId)).toEqual(source); expect(await deps.blobs.read(source.relativePath)).toEqual(sourceBytes);
    expect(record).toMatchObject({ candidateId: ids.candidate, manifestVersion: 1, revision: 0 });
  });
  it("applies saved effects with overlays sorted by zIndex, ties by array order", async () => {
    const red = await insertImage(12, await solid(4, 4, [255, 0, 0, 255])); const blue = await insertImage(13, await solid(4, 4, [0, 0, 255, 255])); const green = await insertImage(14, await solid(4, 4, [0, 255, 0, 255]));
    await saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, layers: [layer(red, { zIndex: 2 }), layer(blue, { zIndex: 1 }), layer(green, { zIndex: 1, x: 2 })] });
    const out = await pixels(await deps.blobs.read(deps.repo.get("media", (await exportCandidate(deps, { candidateId: ids.candidate })).pngMediaId)!.relativePath));
    expect(out.at(1, 1)).toEqual([255, 0, 0, 255]); expect(out.at(5, 1)).toEqual([0, 255, 0, 255]); expect(out.at(10, 10)).toEqual([120, 60, 30, 255]);
  });
  it("writes a schema-valid manifest of the workspace just before this export, without paths or secrets", async () => {
    const first = await exportCandidate(deps, { candidateId: ids.candidate });
    clock = "2026-10-26T00:10:00.000Z"; const second = await exportCandidate(deps, { candidateId: ids.candidate });
    const { bytes } = await readExportManifest(deps, second.id); const text = Buffer.from(bytes).toString("utf8");
    const manifest = Manifest.parse(JSON.parse(text));
    expect(manifest).toMatchObject({ schemaVersion: 1, exportedAt: clock, candidateId: ids.candidate });
    expect(manifest.workspace.exports.map(e => e.id)).toEqual([first.id]);
    expect(manifest.workspace.media.map(m => m.id)).toContain(first.pngMediaId);
    expect(manifest.workspace.media.map(m => m.id)).not.toContain(second.pngMediaId);
    expect(manifest.files).toEqual(manifest.workspace.media.map(m => ({ mediaId: m.id, path: m.relativePath, sha256: m.sha256 })));
    expect(Object.keys(manifest.workspace)).not.toContain("previews");
    for (const secret of [w.root, "FAL_KEY", "queue.fal.run", process.cwd()]) expect(text).not.toContain(secret);
  });
  it("commits nothing when the base or an overlay file is missing or changed", async () => {
    const overlay = await insertImage(15, await solid(2, 2, [0, 0, 0, 255]));
    await saveEffects(deps, ids.candidate, { ...ident, expectedRevision: 0, layers: [layer(overlay)] });
    const count = () => [deps.repo.list("media", ids.project).length, deps.repo.list("exports", ids.project).length];
    const before = count();
    const overlayPath = join(w.root, deps.repo.get("media", overlay)!.relativePath); rmSync(overlayPath);
    expect(await rejection(exportCandidate(deps, { candidateId: ids.candidate }))).toBe("STORAGE");
    writeFileSync(join(w.root, deps.repo.get("media", baseId)!.relativePath), "tampered");
    expect(await rejection(exportCandidate(deps, { candidateId: ids.candidate }))).toBe("STORAGE");
    expect(count()).toEqual(before);
    expect(await rejection(exportCandidate(deps, { candidateId: id(999) }))).toBe("NOT_FOUND");
    expect(await rejection(exportCandidate(deps, { candidateId: "nope" }))).toBe("VALIDATION");
  });
});

describe("EffectsCanvas helpers", () => {
  it("uses the contract filter order and converts dragged centers to stored top-left", () => {
    expect(cssFilter({ brightness: 1.2, contrast: 0.8, saturation: 0, blur: 0.1 }, 0.5)).toBe("brightness(1.2) contrast(0.8) saturate(0) blur(0.15px)");
    expect(cssFilter({ brightness: 1, contrast: 1, saturation: 1, blur: 0 }, 1)).toBe("brightness(1) contrast(1) saturate(1) blur(0px)");
    expect(topLeftFromCenter({ x: 50, y: 40 }, { width: 20, height: 10 })).toEqual({ x: 40, y: 35 });
    expect(topLeftFromCenter({ x: 9000, y: -9000 }, { width: 2, height: 2 })).toEqual({ x: 4096, y: -4096 });
  });
});

describe("effects/export routes", () => {
  let w: ReturnType<typeof world>; let deps: Dependencies;
  beforeEach(async () => {
    w = world(); deps = { ...w.deps, blobs: createLocalBlobStore(w.root) }; container.deps = deps;
    const { seedCandidate } = await import("../support/seed-candidate"); await seedCandidate(deps);
  });
  afterEach(() => { container.deps = null; w.dispose(); });
  const ctx = (value: string) => ({ params: Promise.resolve({ id: value }) });
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api", { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  it("saves/reads effects, exports and serves the manifest file by export ID only", async () => {
    expect((await (await effectsRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx(ids.candidate))).json()).data).toBeNull();
    const saved = await effectsRoute.PUT(json("PUT", { ...ident, expectedRevision: 0 }), ctx(ids.candidate));
    expect(saved.status).toBe(200);
    expect((await effectsRoute.PUT(json("PUT", { ...ident, expectedRevision: 5 }), ctx(ids.candidate))).status).toBe(409);
    const exported = await exportsRoute.POST(json("POST", { candidateId: ids.candidate }));
    const record = (await exported.json()).data; expect(exported.status).toBe(200);
    const file = await manifestRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx(record.id));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("application/json"); expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("content-disposition")).toContain(`manifest-${record.id}.json`);
    expect(Manifest.parse(await file.json()).candidateId).toBe(ids.candidate);
  });
  it("rejects bad ids, path-like ids, unknown exports and cross-origin writes", async () => {
    expect((await manifestRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx("../../db.sqlite"))).status).toBe(400);
    expect((await manifestRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx(id(999)))).status).toBe(404);
    expect((await effectsRoute.GET(new Request("http://127.0.0.1:3000/api"), ctx(id(999)))).status).toBe(404);
    expect((await exportsRoute.POST(json("POST", { candidateId: ids.candidate, path: "/etc" }))).status).toBe(400);
    expect((await exportsRoute.POST(json("POST", { candidateId: ids.candidate }, { origin: "https://evil.example" }))).status).toBe(403);
  });
});
