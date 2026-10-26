import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BlobStore, StoredBytes } from "../../application/ports";
import { AppError } from "../../domain/errors";

const extensions = ["png", "jpeg", "webp", "json"] as const;
type Extension = (typeof extensions)[number];
/** The only accepted relative path shape; rejects absolute, `..`, separators and foreign names up front. */
const blobPath = /^blobs\/([a-f0-9]{64})\.(png|jpeg|webp|json)$/;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const storage = (message: string): never => { throw new AppError("STORAGE", message); };
const isInside = (parent: string, child: string) => { const rel = relative(parent, child); return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && resolve(parent, rel) === child; };
const code = (error: unknown) => (error as { code?: unknown })?.code;

/** T02: content-addressed immutable blobs, atomic write, confined paths. Errors never include absolute paths. */
export function createLocalBlobStore(root: string): BlobStore {
  const base = resolve(root);

  /** Real blobs directory, which must stay inside the real root (no symlinked escape). */
  async function blobsDir(create: boolean): Promise<string> {
    try {
      if (create) await mkdir(join(base, "blobs"), { recursive: true });
      const realRoot = await realpath(base); const realBlobs = await realpath(join(base, "blobs"));
      if (!isInside(realRoot, realBlobs)) storage("Blob directory escapes storage root");
      return realBlobs;
    } catch (error) {
      if (error instanceof AppError) throw error;
      return storage(code(error) === "ENOENT" ? "Blob file not found" : "Blob storage unavailable");
    }
  }

  /** Reads a confined regular file; symlinks are rejected even when they point inside the root. */
  async function readConfined(dir: string, name: string): Promise<Buffer | null> {
    const target = join(dir, name);
    try {
      if (!(await lstat(target)).isFile()) storage("Blob path is not a regular file");
      return await readFile(target);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (code(error) === "ENOENT") return null;
      return storage("Blob read failed");
    }
  }

  return {
    async write(bytes: Uint8Array, extension: Extension): Promise<StoredBytes> {
      if (!(bytes instanceof Uint8Array)) throw new AppError("VALIDATION", "Blob bytes must be a Uint8Array");
      if (!extensions.includes(extension)) throw new AppError("VALIDATION", "Unsupported blob extension");
      const hash = sha256(bytes); const name = `${hash}.${extension}`;
      const stored = { relativePath: `blobs/${name}`, sha256: hash, bytes: bytes.length };
      const dir = await blobsDir(true);
      const verifyExisting = async () => {
        const existing = await readConfined(dir, name);
        if (!existing) return false;
        if (sha256(existing) !== hash) storage("Existing blob content does not match its hash");
        return true;
      };
      if (await verifyExisting()) return stored;
      // Write a private temp file, then hard-link it into place: atomic and never overwrites an existing blob.
      const temp = join(dir, `.tmp-${randomUUID()}`);
      try {
        await writeFile(temp, bytes, { flag: "wx" });
        try { await link(temp, join(dir, name)); }
        catch (error) { if (code(error) !== "EEXIST" || !(await verifyExisting())) throw error; }
      } catch (error) {
        if (error instanceof AppError) throw error;
        storage("Blob write failed");
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      return stored;
    },
    async read(relativePath: string): Promise<Uint8Array> {
      const match = typeof relativePath === "string" ? blobPath.exec(relativePath) : null;
      if (!match) throw new AppError("VALIDATION", "Invalid blob path");
      const bytes = await readConfined(await blobsDir(false), `${match[1]}.${match[2]}`);
      if (!bytes) return storage("Blob file not found");
      if (sha256(bytes) !== match[1]) storage("Blob content does not match its hash");
      return new Uint8Array(bytes);
    },
  };
}
