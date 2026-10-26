import Database from "better-sqlite3";
import { and, eq, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ZodType } from "zod";
import * as C from "../../contracts";
import type { Entities, EntityKind, Repository, UnitOfWork } from "../../application/ports";
import { AppError } from "../../domain/errors";
import * as s from "./schema";

/** All aggregate tables share id/revision/body; casting to one shape keeps generic Drizzle queries typed. */
type Table = typeof s.scenes;
type Body = Record<string, unknown> & { id: string; projectId: string; revision: number; createdAt: string };
interface Spec {
  table: Table;
  schema: ZodType;
  /** false only for projects, whose scope column is the id itself. */
  scoped: boolean;
  mutability: "append-only" | "approval" | "mutable";
  /** Body fields frozen in addition to id/projectId/createdAt. */
  fixed: readonly string[];
  /** Indexed identity columns duplicated from the body. */
  columns?: (body: Body) => Record<string, unknown>;
  /** FK columns that must point at a record in the same project. */
  references?: readonly { kind: EntityKind; field: string }[];
}
const table = (value: unknown) => value as Table;
const versioned = (body: Body) => ({ logicalId: body.logicalId, version: body.version });
const specs: { [K in EntityKind]: Spec } = {
  projects: { table: table(s.projects), schema: C.Project, scoped: false, mutability: "mutable", fixed: [] },
  media: { table: table(s.media), schema: C.Media, scoped: true, mutability: "append-only", fixed: [] },
  styles: { table: table(s.styles), schema: C.Style, scoped: true, mutability: "approval", fixed: [], columns: versioned },
  assets: { table: table(s.assets), schema: C.Asset, scoped: true, mutability: "approval", fixed: [], columns: versioned },
  scenes: { table: table(s.scenes), schema: C.Scene, scoped: true, mutability: "mutable", fixed: [] },
  previews: { table: table(s.previews), schema: C.Preview, scoped: true, mutability: "append-only", fixed: [] },
  runs: { table: table(s.runs), schema: C.Run, scoped: true, mutability: "mutable", fixed: ["previewId", "idempotencyKey", "snapshot", "compiled"], columns: b => ({ previewId: b.previewId, idempotencyKey: b.idempotencyKey }), references: [{ kind: "previews", field: "previewId" }] },
  candidates: { table: table(s.candidates), schema: C.Candidate, scoped: true, mutability: "append-only", fixed: [], columns: b => ({ runId: b.runId, outputIndex: b.index }), references: [{ kind: "runs", field: "runId" }] },
  reviews: { table: table(s.reviews), schema: C.Review, scoped: true, mutability: "append-only", fixed: [] },
  effects: { table: table(s.effects), schema: C.Effects, scoped: true, mutability: "mutable", fixed: ["candidateId"], columns: b => ({ candidateId: b.candidateId }), references: [{ kind: "candidates", field: "candidateId" }] },
  exports: { table: table(s.exports), schema: C.ExportRecord, scoped: true, mutability: "append-only", fixed: [] },
  experiments: { table: table(s.experiments), schema: C.Experiment, scoped: true, mutability: "mutable", fixed: ["sceneIds", "sceneRevisions"] },
};
const requiredTables = [...Object.keys(specs), "worker_lease", "schema_migrations"];

const fail = (code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "STORAGE", message: string): never => { throw new AppError(code, message); };

/** Library exceptions become AppErrors without raw SQL, paths or values. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code !== "string" || !code.startsWith("SQLITE_")) continue;
    if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return new AppError("CONFLICT", "Duplicate record identity");
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return new AppError("NOT_FOUND", "Referenced record not found");
    if (code.startsWith("SQLITE_CONSTRAINT")) return new AppError("VALIDATION", "Record violates storage constraints");
    return new AppError("STORAGE", `Storage operation failed (${code})`);
  }
  return new AppError("STORAGE", "Storage operation failed");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const omit = (body: Body, keys: readonly string[]) => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));

function specOf(kind: EntityKind): Spec {
  return Object.hasOwn(specs, kind) ? specs[kind] : fail("VALIDATION", "Unknown entity kind");
}
function validate(kind: EntityKind, value: unknown): Body {
  const parsed = specOf(kind).schema.safeParse(value);
  if (!parsed.success) fail("VALIDATION", `Invalid ${kind} record at ${parsed.error.issues[0]?.path.join(".") || "(root)"}`);
  const body = parsed.data as Body;
  if (kind === "projects" && body.projectId !== body.id) fail("VALIDATION", "Project projectId must equal id");
  return body;
}
function instant(value: unknown, field: string): string {
  return C.Timestamp.safeParse(value).success ? new Date(value as string).toISOString() : fail("VALIDATION", `Invalid lease ${field}`);
}
function owner(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 ? value : fail("VALIDATION", "Invalid lease owner");
}

/** Open an already migrated database with FK, WAL and busy timeout. Never migrates implicitly. */
export function openRepository(databasePath: string): Repository {
  let sqlite: Database.Database;
  try { sqlite = new Database(databasePath, { fileMustExist: true }); } catch { return fail("STORAGE", "Database file is missing or cannot be opened; run npm run db:migrate"); }
  try {
    sqlite.pragma("foreign_keys = ON"); sqlite.pragma("busy_timeout = 5000");
    if (sqlite.pragma("journal_mode = WAL", { simple: true }) !== "wal") fail("STORAGE", "Database WAL mode unavailable");
    if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) fail("STORAGE", "Database foreign keys unavailable");
    const present = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
    const missing = requiredTables.filter(name => !present.has(name));
    if (missing.length) fail("STORAGE", `Database schema is not installed (missing ${missing.join(", ")}); run npm run db:migrate`);
  } catch (error) { sqlite.close(); throw toAppError(error); }
  return createRepository(sqlite);
}

function createRepository(sqlite: Database.Database): Repository {
  const db = drizzle({ client: sqlite });
  let closed = false;
  const run = <T>(work: () => T): T => {
    if (closed) fail("STORAGE", "Repository is closed");
    try { return work(); } catch (error) { throw toAppError(error); }
  };
  const rollback = () => { if (sqlite.open && sqlite.inTransaction) sqlite.exec("ROLLBACK"); };
  /** Single-call mutations get their own immediate transaction; inside transaction() they join it. */
  const atomic = <T>(work: () => T): T => run(() => {
    if (sqlite.inTransaction) return work();
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = work(); sqlite.exec("COMMIT"); return result; } catch (error) { rollback(); throw error; }
  });

  const decode = (kind: EntityKind, row: Record<string, unknown>): Body => {
    const spec = specOf(kind); const parsed = spec.schema.safeParse(row.body);
    if (!parsed.success) return fail("STORAGE", `Stored ${kind} record is corrupted`);
    const body = parsed.data as Body;
    const columns = { id: body.id, revision: body.revision, ...(spec.scoped ? { projectId: body.projectId } : {}), ...spec.columns?.(body) };
    if (!same(columns, Object.fromEntries(Object.keys(columns).map(k => [k, row[k]]))) || (!spec.scoped && body.projectId !== body.id)) fail("STORAGE", `Stored ${kind} record columns do not match body`);
    return body;
  };
  const find = (kind: EntityKind, id: string): Body | null => {
    const t = specOf(kind).table; const row = db.select().from(t).where(eq(t.id, id)).get();
    return row ? decode(kind, row) : null;
  };
  const checkReferences = (spec: Spec, body: Body) => {
    if (spec.scoped && !find("projects", body.projectId)) fail("NOT_FOUND", "Project not found");
    for (const ref of spec.references ?? []) {
      const target = find(ref.kind, body[ref.field] as string);
      if (!target || target.projectId !== body.projectId) fail("NOT_FOUND", `Referenced ${ref.kind} record not found`);
    }
  };
  const checkMutation = (kind: EntityKind, spec: Spec, current: Body, next: Body) => {
    if (spec.mutability === "append-only") fail("CONFLICT", `${kind} records are append-only`);
    for (const field of ["id", "projectId", "createdAt", ...spec.fixed]) if (!same(current[field], next[field])) fail("CONFLICT", `${kind}.${field} is immutable`);
    if (spec.mutability === "approval") {
      if (current.approvedAt !== null) fail("CONFLICT", `Approved ${kind} version is immutable; create a new version`);
      if (next.approvedAt === null || !same(omit(current, ["revision", "approvedAt"]), omit(next, ["revision", "approvedAt"]))) fail("CONFLICT", `Only first approval may change a ${kind} version`);
    }
  };

  const unit: UnitOfWork = {
    get<K extends EntityKind>(kind: K, id: string) {
      return run(() => typeof id === "string" ? find(kind, id) as Entities[K] | null : fail("VALIDATION", "Invalid id"));
    },
    list<K extends EntityKind>(kind: K, projectId?: string) {
      return run(() => {
        const spec = specOf(kind); const t = spec.table;
        if (projectId !== undefined && typeof projectId !== "string") fail("VALIDATION", "Invalid projectId");
        const query = db.select().from(t);
        const rows = projectId === undefined ? query.all() : query.where(eq(spec.scoped ? t.projectId : t.id, projectId)).all();
        return rows.map(row => decode(kind, row))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as Entities[K][];
      });
    },
    insert<K extends EntityKind>(kind: K, value: Entities[K]) {
      atomic(() => {
        const spec = specOf(kind); const body = validate(kind, value);
        if (body.revision !== 0) fail("VALIDATION", "New records must start at revision 0");
        checkReferences(spec, body);
        db.insert(spec.table).values({ id: body.id, projectId: body.projectId, revision: 0, body: body as never, ...spec.columns?.(body) }).run();
      });
    },
    replace<K extends EntityKind>(kind: K, value: Entities[K], expectedRevision: number) {
      atomic(() => {
        const spec = specOf(kind); const t = spec.table;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("VALIDATION", "Invalid expectedRevision");
        const body = validate(kind, value);
        if (body.revision !== expectedRevision + 1) fail("VALIDATION", "Replacement revision must be expectedRevision + 1");
        const current = find(kind, body.id);
        if (!current) return fail("NOT_FOUND", `${kind} record not found`);
        if (current.revision !== expectedRevision) fail("CONFLICT", `Stale ${kind} revision`);
        checkMutation(kind, spec, current, body);
        const result = db.update(t).set({ revision: body.revision, body: body as never }).where(and(eq(t.id, body.id), eq(t.revision, expectedRevision))).run();
        if (result.changes !== 1) fail("CONFLICT", `Stale ${kind} revision`);
      });
    },
    acquireLease(leaseOwner: string, now: string, until: string) {
      return atomic(() => {
        const who = owner(leaseOwner); const at = instant(now, "now"); const expiresAt = instant(until, "until");
        if (expiresAt <= at) fail("VALIDATION", "Lease must expire after now");
        const l = s.workerLease;
        return db.insert(l).values({ id: 1, owner: who, expiresAt }).onConflictDoUpdate({ target: l.id, set: { owner: who, expiresAt }, setWhere: or(eq(l.owner, who), lte(l.expiresAt, at)) }).run().changes === 1;
      });
    },
    releaseLease(leaseOwner: string) {
      atomic(() => { db.delete(s.workerLease).where(and(eq(s.workerLease.id, 1), eq(s.workerLease.owner, owner(leaseOwner)))).run(); });
    },
  };

  return {
    ...unit,
    transaction<T>(work: (tx: UnitOfWork) => T): T {
      if (typeof work !== "function") fail("VALIDATION", "Transaction work must be a function");
      run(() => { if (sqlite.inTransaction) fail("VALIDATION", "Nested transactions are not supported"); sqlite.exec("BEGIN IMMEDIATE"); });
      let open = true;
      const guard = <A extends unknown[], R>(op: (...args: A) => R) => (...args: A): R => open ? op(...args) : fail("VALIDATION", "Transaction has already finished");
      const tx: UnitOfWork = { get: guard(unit.get), list: guard(unit.list), insert: guard(unit.insert), replace: guard(unit.replace), acquireLease: guard(unit.acquireLease), releaseLease: guard(unit.releaseLease) } as UnitOfWork;
      let result: T;
      try { result = work(tx); } catch (error) { open = false; rollback(); throw error; }
      open = false;
      if (result && typeof (result as { then?: unknown }).then === "function") {
        rollback(); Promise.resolve(result).catch(() => undefined);
        return fail("VALIDATION", "Transaction work must be synchronous");
      }
      run(() => { try { sqlite.exec("COMMIT"); } catch (error) { rollback(); throw error; } });
      return result;
    },
    close() {
      if (closed) return;
      closed = true; rollback(); sqlite.close();
    },
  };
}
