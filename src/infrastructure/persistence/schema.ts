import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import type * as C from "../../contracts";
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Project>().notNull(),
});
export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Media>().notNull(),
});
export const styles = sqliteTable("styles", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Style>().notNull(),
  logicalId: text("logical_id").notNull(),
  version: integer("version").notNull(),
}, t => [uniqueIndex("styles_identity").on(t.projectId,t.logicalId,t.version)]);
export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Asset>().notNull(),
  logicalId: text("logical_id").notNull(),
  version: integer("version").notNull(),
}, t => [uniqueIndex("assets_identity").on(t.projectId,t.logicalId,t.version)]);
export const scenes = sqliteTable("scenes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Scene>().notNull(),
});
export const previews = sqliteTable("previews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Preview>().notNull(),
});
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Run>().notNull(),
  previewId: text("preview_id").notNull().references(() => previews.id),
  idempotencyKey: text("idempotency_key").notNull(),
}, t => [uniqueIndex("runs_identity").on(t.projectId,t.idempotencyKey), uniqueIndex("runs_preview").on(t.previewId)]);
export const candidates = sqliteTable("candidates", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Candidate>().notNull(),
  runId: text("run_id").notNull().references(() => runs.id),
  outputIndex: integer("output_index").notNull(),
}, t => [uniqueIndex("candidates_identity").on(t.runId,t.outputIndex)]);
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Review>().notNull(),
});
export const effects = sqliteTable("effects", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Effects>().notNull(),
  candidateId: text("candidate_id").notNull().references(() => candidates.id),
}, t => [uniqueIndex("effects_identity").on(t.candidateId)]);
export const exports = sqliteTable("exports", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.ExportRecord>().notNull(),
});
export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  revision: integer("revision").notNull(),
  body: text("body", { mode: "json" }).$type<C.Experiment>().notNull(),
});
export const workerLease = sqliteTable("worker_lease", { id: integer("id").primaryKey(), owner: text("owner").notNull(), expiresAt: text("expires_at").notNull() });
