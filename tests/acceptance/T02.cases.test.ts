// T02 normal/error/boundary cases: blob store, image inspector, media service and media HTTP routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { Dependencies } from "../../src/application/ports";
import { readMedia, uploadMedia } from "../../src/application/services/media";
import { Limits } from "../../src/contracts";
import { createSharpImageInspector } from "../../src/infrastructure/images/sharp";
import { MOCK_PNG_BASE64 } from "../../src/infrastructure/models/mock";
import { createLocalBlobStore } from "../../src/infrastructure/storage/local";
import { ids } from "../support/fixtures";
import { world } from "../support/world";

// Composition root is T12. Route tests wire the real T01/T02 implementations through a test double of the container.
const container = vi.hoisted(() => ({ deps: null as Dependencies | null }));
vi.mock("../../src/server/container", () => ({ getDependencies: () => { if (!container.deps) throw new Error("test container not set"); return container.deps; } }));
const { POST: upload } = await import("../../src/app/api/media/upload/route");
const { GET: download } = await import("../../src/app/api/media/[id]/route");

const png = new Uint8Array(Buffer.from(MOCK_PNG_BASE64, "base64"));
const image = async (format: "png" | "jpeg" | "webp" | "gif", width = 8, height = 6) => new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })[format]().toBuffer());
const rejection = async (work: Promise<unknown>) => { try { await work; return "no error"; } catch (error) { return (error as { code?: string }).code ?? `raw:${String(error)}`; } };
const blobFiles = (root: string) => existsSync(join(root, "blobs")) ? readdirSync(join(root, "blobs")) : [];
/** Hand-built fixtures: sharp cannot encode multi-frame WebP/APNG here, and libvips reports APNG as one page. */
const riffChunk = (id: string, data: Buffer) => { const head = Buffer.alloc(8); head.write(id, 0, "latin1"); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]); };
const u24 = (n: number) => { const b = Buffer.alloc(3); b.writeUIntLE(n, 0, 3); return b; };
async function animatedWebp(): Promise<Uint8Array> {
  const frame = (await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c33" } }).webp({ lossless: true }).toBuffer()).subarray(12);
  const anmf = () => riffChunk("ANMF", Buffer.concat([u24(0), u24(0), u24(3), u24(3), u24(100), Buffer.from([0]), frame]));
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), riffChunk("VP8X", Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(3), u24(3)])), riffChunk("ANIM", Buffer.alloc(6)), anmf(), anmf()]);
  const head = Buffer.from("RIFF0000", "latin1"); head.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}
function apng(): Uint8Array {
  const source = Buffer.from(png); const ihdrEnd = 8 + 12 + source.readUInt32BE(8);
  const data = Buffer.alloc(8); data.writeUInt32BE(2, 0); const typed = Buffer.concat([Buffer.from("acTL", "latin1"), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(8); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
  return new Uint8Array(Buffer.concat([source.subarray(0, ihdrEnd), length, typed, crc, source.subarray(ihdrEnd)]));
}

let w: ReturnType<typeof world>; let deps: Dependencies;
beforeEach(() => { w = world(); deps = { ...w.deps, blobs: createLocalBlobStore(w.root) }; container.deps = deps; });
afterEach(() => { container.deps = null; w.dispose(); });
const input = (bytes: Uint8Array, declaredMime = "image/png", licenseNotes = "") => ({ projectId: ids.project, bytes, declaredMime, licenseNotes });

describe("local blob store", () => {
  it("is content addressed, idempotent and leaves no temp files", async () => {
    const blobs = createLocalBlobStore(w.root);
    const a = await blobs.write(png, "png"); const b = await blobs.write(png, "png");
    expect(a).toEqual(b); expect(a.relativePath).toMatch(/^blobs\/[a-f0-9]{64}\.png$/); expect(a.bytes).toBe(png.length);
    expect(blobFiles(w.root)).toEqual([a.relativePath.slice(6)]);
    expect(await blobs.read(a.relativePath)).toEqual(png);
    expect((await blobs.write(png, "json")).relativePath).not.toBe(a.relativePath);
  });
  it("rejects traversal, absolute and malformed paths with VALIDATION and missing files with STORAGE", async () => {
    const blobs = createLocalBlobStore(w.root);
    for (const path of ["../outside", "/etc/passwd", "blobs/../db.sqlite", `blobs/${"a".repeat(64)}.svg`, `blobs/${"A".repeat(64)}.png`, `blobs/sub/${"a".repeat(64)}.png`]) expect(await rejection(blobs.read(path))).toBe("VALIDATION");
    expect(await rejection(blobs.read(`blobs/${"a".repeat(64)}.png`))).toBe("STORAGE");
    expect(await rejection(blobs.write(png, "svg" as "png"))).toBe("VALIDATION");
  });
  it("never overwrites or serves a blob whose bytes no longer match its hash", async () => {
    const blobs = createLocalBlobStore(w.root); const stored = await blobs.write(png, "png");
    writeFileSync(join(w.root, stored.relativePath), "tampered");
    expect(await rejection(blobs.read(stored.relativePath))).toBe("STORAGE");
    expect(await rejection(blobs.write(png, "png"))).toBe("STORAGE");
  });
  it("rejects symlinked files and a symlinked blob directory that escape the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "blob-outside-"));
    try {
      const blobs = createLocalBlobStore(w.root); const stored = await blobs.write(png, "png");
      const name = stored.relativePath.slice(6); writeFileSync(join(outside, name), png);
      rmSync(join(w.root, stored.relativePath)); symlinkSync(join(outside, name), join(w.root, stored.relativePath));
      expect(await rejection(blobs.read(stored.relativePath))).toBe("STORAGE");
      const other = mkdtempSync(join(tmpdir(), "blob-root-")); symlinkSync(outside, join(other, "blobs"));
      try {
        const escaped = createLocalBlobStore(other);
        expect(await rejection(escaped.write(png, "png"))).toBe("STORAGE");
        expect(await rejection(escaped.read(stored.relativePath))).toBe("STORAGE");
      } finally { rmSync(other, { recursive: true, force: true }); }
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("sharp image inspector", () => {
  const inspector = createSharpImageInspector();
  it("decodes PNG, JPEG and WebP and reports GIF/animation for the caller to judge", async () => {
    for (const [format, mime] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"]] as const) expect(await inspector.inspect(await image(format))).toEqual({ mime, width: 8, height: 6, pages: 1 });
    expect(await inspector.inspect(await animatedWebp())).toEqual({ mime: "image/webp", width: 4, height: 4, pages: 2 });
    expect(await inspector.inspect(apng())).toEqual({ mime: "image/png", width: 1, height: 1, pages: 2 });
  });
  it("fails truncated, corrupted, SVG and empty input with INVALID_MEDIA and does not mutate bytes", async () => {
    const full = await image("png", 64, 64); const copy = full.slice();
    await inspector.inspect(full); expect(full).toEqual(copy);
    const jpeg = await image("jpeg", 64, 64);
    const corrupt = full.slice(); corrupt.fill(7, 40, 60);
    for (const bad of [full.slice(0, full.length - 20), jpeg.slice(0, jpeg.length / 2), corrupt, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), new Uint8Array()]) expect(await rejection(inspector.inspect(bad))).toBe("INVALID_MEDIA");
  });
});

describe("media service", () => {
  it("stores PNG/JPEG/WebP unchanged and re-reads identical bytes", async () => {
    for (const [format, mime] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]] as const) {
      const bytes = await image(format); const copy = bytes.slice();
      const media = await uploadMedia(deps, input(bytes, mime.toUpperCase(), "own work"));
      expect(media).toMatchObject({ projectId: ids.project, revision: 0, mime, width: 8, height: 6, bytes: bytes.length, source: "upload", licenseNotes: "own work" });
      expect(bytes).toEqual(copy);
      expect(await readMedia(deps, media.id)).toEqual({ media, bytes });
      expect(deps.repo.get("media", media.id)).toEqual(media);
    }
  });
  it("gives re-uploads a new Media ID that shares the same blob", async () => {
    const a = await uploadMedia(deps, input(png)); const b = await uploadMedia(deps, input(png));
    expect(b.id).not.toBe(a.id); expect(b.relativePath).toBe(a.relativePath); expect(blobFiles(w.root)).toHaveLength(1);
  });
  it("fails a missing project before any blob is written", async () => {
    expect(await rejection(uploadMedia(deps, { ...input(png), projectId: "00000000-0000-4000-8000-000000000999" }))).toBe("NOT_FOUND");
    expect(await rejection(uploadMedia(deps, { ...input(png), projectId: "not-a-uuid" }))).toBe("VALIDATION");
    expect(existsSync(join(w.root, "blobs"))).toBe(false);
  });
  it("enforces byte, pixel, MIME, frame and license limits without storing anything", async () => {
    expect(await rejection(uploadMedia(deps, input(new Uint8Array())))).toBe("INVALID_MEDIA");
    expect(await rejection(uploadMedia(deps, input(new Uint8Array(Limits.uploadBytes + 1))))).toBe("TOO_LARGE");
    expect(await rejection(uploadMedia(deps, input(await image("png", 4001, 4000))))).toBe("TOO_LARGE");
    expect(await rejection(uploadMedia(deps, input(png, "image/jpeg")))).toBe("INVALID_MEDIA");
    expect(await rejection(uploadMedia(deps, input(await image("gif"), "image/gif")))).toBe("UNSUPPORTED");
    expect(await rejection(uploadMedia(deps, input(await image("gif"), "image/png")))).toBe("INVALID_MEDIA");
    expect(await rejection(uploadMedia(deps, input(new TextEncoder().encode("<svg/>"), "image/svg+xml")))).toBe("UNSUPPORTED");
    expect(await rejection(uploadMedia(deps, input(await animatedWebp(), "image/webp")))).toBe("UNSUPPORTED");
    expect(await rejection(uploadMedia(deps, input(apng())))).toBe("UNSUPPORTED");
    const truncated = await image("png", 64, 64);
    expect(await rejection(uploadMedia(deps, input(truncated.slice(0, truncated.length - 20))))).toBe("INVALID_MEDIA");
    expect(await rejection(uploadMedia(deps, input(png, "image/png", "x".repeat(2001))))).toBe("VALIDATION");
    expect(blobFiles(w.root)).toEqual([]); expect(deps.repo.list("media", ids.project)).toEqual([]);
    expect((await uploadMedia(deps, input(png, "image/png", "x".repeat(2000)))).licenseNotes).toHaveLength(2000);
  });
  it("accepts exactly 16 megapixels", async () => {
    expect((await uploadMedia(deps, input(await image("png", 4000, 4000)))).width).toBe(4000);
  });
  it("reports unknown IDs as NOT_FOUND and missing files as STORAGE", async () => {
    expect(await rejection(readMedia(deps, "00000000-0000-4000-8000-000000000999"))).toBe("NOT_FOUND");
    expect(await rejection(readMedia(deps, "../x"))).toBe("VALIDATION");
    const media = await uploadMedia(deps, input(png)); rmSync(join(w.root, media.relativePath));
    expect(await rejection(readMedia(deps, media.id))).toBe("STORAGE");
  });
});

describe("media HTTP", () => {
  const url = "http://127.0.0.1:3000/api/media/upload";
  const form = (entries: [string, string | Blob, string?][]) => { const f = new FormData(); for (const [k, v, name] of entries) { if (typeof v === "string") f.append(k, v); else f.append(k, v, name ?? "upload.png"); } return f; };
  const post = (body: BodyInit, headers: Record<string, string> = {}) => upload(new Request(url, { method: "POST", body, headers }));
  const error = async (response: Response) => ({ status: response.status, code: (await response.json()).error.code });

  it("uploads a multipart file and serves raw bytes with safe headers", async () => {
    const response = await post(form([["file", new Blob([png], { type: "image/png" })], ["projectId", ids.project], ["licenseNotes", "mine"]]));
    expect(response.status).toBe(200);
    const { data } = await response.json(); expect(data).toMatchObject({ mime: "image/png", licenseNotes: "mine" });
    expect(JSON.stringify(data)).not.toContain(w.root);
    const got = await download(new Request(`http://127.0.0.1:3000/api/media/${data.id}`), { params: Promise.resolve({ id: data.id }) });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png"); expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
  });
  it("defaults licenseNotes to an empty string", async () => {
    const response = await post(form([["file", new Blob([png], { type: "image/png" })], ["projectId", ids.project]]));
    expect((await response.json()).data.licenseNotes).toBe("");
  });
  it("rejects malformed, duplicate, unexpected and missing fields with 400", async () => {
    const file = new Blob([png], { type: "image/png" });
    expect(await error(await post(JSON.stringify({}), { "content-type": "application/json" }))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post(form([["file", file], ["file", file], ["projectId", ids.project]])))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post(form([["file", file], ["projectId", ids.project], ["projectId", ids.project]])))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post(form([["file", file], ["projectId", ids.project], ["path", "/tmp/x"]])))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post(form([["projectId", ids.project]])))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post(form([["file", "not a file"], ["projectId", ids.project]])))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await post("garbage", { "content-type": "multipart/form-data; boundary=x" }))).toEqual({ status: 400, code: "VALIDATION" });
  });
  it("maps spoofed MIME to 422 and cross-origin uploads to 403", async () => {
    expect(await error(await post(form([["file", new Blob([png], { type: "image/jpeg" }), "x.jpg"], ["projectId", ids.project]])))).toEqual({ status: 422, code: "INVALID_MEDIA" });
    expect(await error(await post(form([["file", new Blob([png], { type: "image/png" })], ["projectId", ids.project]]), { origin: "https://evil.example" }))).toEqual({ status: 403, code: "FORBIDDEN" });
  });
  it("returns 413 for oversized bodies by Content-Length or streamed count, and for oversized files", async () => {
    expect(await error(await post("x", { "content-type": "multipart/form-data; boundary=x", "content-length": String(Limits.uploadBytes + 64 * 1024 + 1) }))).toEqual({ status: 413, code: "TOO_LARGE" });
    const chunk = new Uint8Array(1024 * 1024); let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 12) c.enqueue(chunk); else c.close(); } });
    const streamed = await upload(new Request(url, { method: "POST", body: stream, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit));
    expect(await error(streamed)).toEqual({ status: 413, code: "TOO_LARGE" });
    expect(sent).toBeLessThan(13);
    const big = form([["file", new Blob([new Uint8Array(Limits.uploadBytes + 1)], { type: "image/png" })], ["projectId", ids.project]]);
    expect(await error(await post(big))).toEqual({ status: 413, code: "TOO_LARGE" });
  });
  it("GET returns JSON errors: 400 invalid id, 404 unknown, 500 missing file without paths", async () => {
    const get = (id: string) => download(new Request(`http://127.0.0.1:3000/api/media/${id}`), { params: Promise.resolve({ id }) });
    expect(await error(await get("nope"))).toEqual({ status: 400, code: "VALIDATION" });
    expect(await error(await get("00000000-0000-4000-8000-000000000999"))).toEqual({ status: 404, code: "NOT_FOUND" });
    const media = await uploadMedia(deps, input(png)); rmSync(join(w.root, media.relativePath));
    const missing = await get(media.id); const text = await missing.text();
    expect(missing.status).toBe(500); expect(text).toContain("STORAGE"); expect(text).not.toContain(w.root);
  });
});

it("rejects the upload when the blob directory cannot be created", async () => {
  writeFileSync(join(w.root, "blobs"), "a file, not a directory");
  expect(await rejection(uploadMedia(deps, input(png)))).toBe("STORAGE");
  expect(deps.repo.list("media", ids.project)).toEqual([]);
});
