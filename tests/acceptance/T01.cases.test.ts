// T01 normal/error/boundary cases for the SQLite repository. Uses a temp APP data root per test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repository } from "../../src/application/ports";
import type { Media, Project, Run, Style } from "../../src/contracts";
import { AppError } from "../../src/domain/errors";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
import { openRepository } from "../../src/infrastructure/persistence/repository";
import { compiled, ids, now, project, snapshot } from "../support/fixtures";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const code = (work: () => unknown) => { try { work(); } catch (error) { return error instanceof AppError ? error.code : `raw:${String(error)}`; } return "no error"; };
const media = (n: number, projectId = ids.project): Media => ({ id: id(n), projectId, revision: 0, createdAt: now, sha256: "b".repeat(64), mime: "image/png", width: 1, height: 1, bytes: 1, relativePath: `blobs/${"b".repeat(64)}.png`, source: "upload", licenseNotes: "" });
const style = (n: number, version = 1): Style => ({ id: id(n), projectId: ids.project, revision: 0, createdAt: now, logicalId: id(900), version, approvedAt: null, referenceIds: [], specification: { linework: "", shading: "", palette: "", anatomy: "", rendering: "", lighting: "", effectsLanguage: "", positive: "clean cel", negative: "" } });
const preview = (n: number, projectId = ids.project) => ({ id: id(n), projectId, revision: 0, createdAt: now, snapshot, compiled, hash: "a".repeat(64), expiresAt: at(15) });
const run = (n: number, previewId: string, key = id(n)): Run => ({ id: id(n), projectId: ids.project, revision: 0, createdAt: now, previewId, idempotencyKey: key, status: "draft", snapshot, compiled, providerRequestId: null, actualCost: { kind: "unknown", reason: "not-reported" }, errorCode: null, updatedAt: now });

let root: string; let path: string; let repo: Repository; const extra: Repository[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "repo-cases-")); path = join(root, "db.sqlite"); migrateDatabase(path); repo = openRepository(path); repo.insert("projects", project); });
afterEach(() => { for (const r of [repo, ...extra.splice(0)]) r.close(); rmSync(root, { recursive: true, force: true }); });

describe("open", () => {
  it("rejects missing, unmigrated and corrupted databases with STORAGE and never creates files", () => {
    expect(code(() => openRepository(join(root, "absent.sqlite")))).toBe("STORAGE");
    const empty = join(root, "empty.sqlite"); new Database(empty).close();
    expect(code(() => openRepository(empty))).toBe("STORAGE");
    const junk = join(root, "junk.sqlite"); writeFileSync(junk, "not a database at all, just text bytes".repeat(200));
    expect(code(() => openRepository(junk))).toBe("STORAGE");
  });
  it("enables WAL on the database file and does not leak the absolute path in errors", () => {
    const probe = new Database(path, { readonly: true });
    expect(probe.pragma("journal_mode", { simple: true })).toBe("wal"); probe.close();
    try { openRepository(join(root, "absent.sqlite")); } catch (error) { expect(String((error as Error).message)).not.toContain(root); }
  });
  it("fails with STORAGE after close and tolerates double close", () => {
    const other = openRepository(path); other.close(); other.close();
    expect(code(() => other.get("projects", ids.project))).toBe("STORAGE");
    expect(code(() => other.transaction(() => 1))).toBe("STORAGE");
  });
});

describe("get / list / insert", () => {
  it("returns null, [] and detached copies; does not mutate inputs", () => {
    expect(repo.get("scenes", id(1))).toBeNull();
    expect(repo.list("media", ids.project)).toEqual([]);
    const input = media(10); const frozen = structuredClone(input); repo.insert("media", input);
    expect(input).toEqual(frozen);
    input.licenseNotes = "mutated after insert";
    const read = repo.get("media", id(10))!; expect(read.licenseNotes).toBe("");
    read.licenseNotes = "mutated after get"; expect(repo.get("media", id(10))!.licenseNotes).toBe("");
  });
  it("lists by createdAt then id and filters by project", () => {
    const other: Project = { ...project, id: id(2), projectId: id(2), title: "Other" };
    repo.insert("projects", other);
    repo.insert("media", { ...media(13), createdAt: at(1) });
    repo.insert("media", media(12)); repo.insert("media", media(11)); repo.insert("media", media(14, id(2)));
    expect(repo.list("media", ids.project).map(m => m.id)).toEqual([id(11), id(12), id(13)]);
    expect(repo.list("media").map(m => m.id)).toEqual([id(11), id(12), id(14), id(13)]);
    expect(repo.list("projects", id(2))).toEqual([other]);
  });
  it("rejects duplicates, bad schema, non-zero revision, unknown project and project id mismatch", () => {
    repo.insert("media", media(10));
    expect(code(() => repo.insert("media", media(10)))).toBe("CONFLICT");
    expect(code(() => repo.insert("media", { ...media(11), sha256: "nope" }))).toBe("VALIDATION");
    expect(code(() => repo.insert("media", { ...media(11), revision: 1 }))).toBe("VALIDATION");
    expect(code(() => repo.insert("media", media(11, id(99))))).toBe("NOT_FOUND");
    expect(code(() => repo.insert("projects", { ...project, id: id(3) }))).toBe("VALIDATION");
    expect(code(() => repo.insert("nonsense" as "media", media(11)))).toBe("VALIDATION");
    expect(repo.list("media", ids.project)).toHaveLength(1);
  });
  it("enforces indexed identities and same-project FK columns", () => {
    repo.insert("styles", style(20));
    expect(code(() => repo.insert("styles", style(21)))).toBe("CONFLICT");
    repo.insert("styles", style(21, 2));
    repo.insert("previews", preview(30)); repo.insert("previews", preview(31));
    repo.insert("runs", run(40, id(30)));
    expect(code(() => repo.insert("runs", run(41, id(31), id(40))))).toBe("CONFLICT"); // idempotency key reuse
    expect(code(() => repo.insert("runs", run(41, id(30))))).toBe("CONFLICT"); // one run per preview
    expect(code(() => repo.insert("runs", run(41, id(98))))).toBe("NOT_FOUND");
    repo.insert("projects", { ...project, id: id(2), projectId: id(2) }); repo.insert("previews", preview(32, id(2)));
    expect(code(() => repo.insert("runs", run(41, id(32))))).toBe("NOT_FOUND"); // preview in another project
  });
});

describe("replace", () => {
  it("applies exactly +1 CAS and keeps root fields fixed", () => {
    repo.replace("projects", { ...project, title: "Renamed", revision: 1 }, 0);
    expect(repo.get("projects", ids.project)).toMatchObject({ title: "Renamed", revision: 1 });
    expect(code(() => repo.replace("projects", { ...project, revision: 1 }, 0))).toBe("CONFLICT");
    expect(code(() => repo.replace("projects", { ...project, revision: 3 }, 1))).toBe("VALIDATION");
    expect(code(() => repo.replace("projects", { ...project, revision: 2, createdAt: at(5) }, 1))).toBe("CONFLICT");
    expect(code(() => repo.replace("projects", { ...project, revision: 1 }, -1))).toBe("VALIDATION");
    expect(code(() => repo.replace("projects", { ...project, id: id(5), projectId: id(5), revision: 1 }, 0))).toBe("NOT_FOUND");
    expect(repo.get("projects", ids.project)!.revision).toBe(1);
  });
  it("treats media and previews as append-only", () => {
    repo.insert("media", media(10)); repo.insert("previews", preview(30));
    expect(code(() => repo.replace("media", { ...media(10), revision: 1 }, 0))).toBe("CONFLICT");
    expect(code(() => repo.replace("previews", { ...preview(30), revision: 1 }, 0))).toBe("CONFLICT");
  });
  it("allows only the first approval of a style version", () => {
    repo.insert("styles", style(20));
    expect(code(() => repo.replace("styles", { ...style(20), revision: 1, approvedAt: now, version: 2 }, 0))).toBe("CONFLICT");
    expect(code(() => repo.replace("styles", { ...style(20), revision: 1 }, 0))).toBe("CONFLICT");
    repo.replace("styles", { ...style(20), revision: 1, approvedAt: now }, 0);
    expect(code(() => repo.replace("styles", { ...style(20), revision: 2, approvedAt: at(1) }, 1))).toBe("CONFLICT");
  });
  it("lets run status move but freezes preview, key, snapshot and compiled", () => {
    repo.insert("previews", preview(30)); repo.insert("runs", run(40, id(30)));
    repo.replace("runs", { ...run(40, id(30)), revision: 1, status: "submitting", updatedAt: at(1) }, 0);
    const current = repo.get("runs", id(40))!;
    expect(code(() => repo.replace("runs", { ...current, revision: 2, compiled: { ...compiled, prompt: "other" } }, 1))).toBe("CONFLICT");
    expect(code(() => repo.replace("runs", { ...current, revision: 2, idempotencyKey: id(77) }, 1))).toBe("CONFLICT");
    expect(repo.get("runs", id(40))!.status).toBe("submitting");
  });
});

describe("transaction", () => {
  it("commits and returns the callback result", () => {
    expect(repo.transaction(tx => { tx.insert("media", media(10)); return tx.list("media", ids.project).length; })).toBe(1);
    expect(repo.get("media", id(10))).not.toBeNull();
  });
  it("rolls back every write when the callback throws", () => {
    expect(() => repo.transaction(tx => { tx.insert("media", media(10)); tx.insert("media", media(10)); })).toThrow(AppError);
    expect(repo.get("media", id(10))).toBeNull();
  });
  it("rejects async callbacks, nesting and use of a finished tx with VALIDATION and rollback", () => {
    expect(code(() => repo.transaction(async tx => { tx.insert("media", media(10)); }))).toBe("VALIDATION");
    expect(repo.get("media", id(10))).toBeNull();
    expect(code(() => repo.transaction(() => repo.transaction(() => 1)))).toBe("VALIDATION");
    let leaked: Parameters<Parameters<Repository["transaction"]>[0]>[0] | undefined;
    repo.transaction(tx => { leaked = tx; });
    expect(code(() => leaked!.get("projects", ids.project))).toBe("VALIDATION");
    repo.insert("media", media(11)); // connection is usable again
  });
});

describe("worker lease", () => {
  it("is exclusive across connections until expiry and only released by its owner", () => {
    const other = openRepository(path); extra.push(other);
    expect(repo.acquireLease("worker-a", now, at(1))).toBe(true);
    expect(other.acquireLease("worker-b", now, at(1))).toBe(false);
    expect(repo.acquireLease("worker-a", at(0.5), at(1.5))).toBe(true); // renew
    expect(other.acquireLease("worker-b", at(1), at(2))).toBe(false); // not yet expired
    other.releaseLease("worker-b"); // not owner: no-op
    expect(other.acquireLease("worker-b", at(1.4), at(2))).toBe(false);
    expect(other.acquireLease("worker-b", at(1.5), at(2.5))).toBe(true); // expired at exactly until
    expect(repo.acquireLease("worker-a", at(1.6), at(2.6))).toBe(false);
    other.releaseLease("worker-b"); other.releaseLease("worker-b");
    expect(repo.acquireLease("worker-a", at(1.6), at(2.6))).toBe(true);
  });
  it("normalizes timestamp precision and validates arguments", () => {
    expect(repo.acquireLease("worker-a", "2026-10-26T00:00:00Z", "2026-10-26T00:00:01Z")).toBe(true);
    expect(repo.acquireLease("worker-b", "2026-10-26T00:00:00.500Z", "2026-10-26T00:00:02Z")).toBe(false);
    expect(code(() => repo.acquireLease("worker-a", now, now))).toBe("VALIDATION");
    expect(code(() => repo.acquireLease("", now, at(1)))).toBe("VALIDATION");
    expect(code(() => repo.acquireLease("worker-a", "yesterday", at(1)))).toBe("VALIDATION");
  });
});
