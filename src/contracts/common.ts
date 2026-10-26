import { z } from "zod";
export const Id = z.string().uuid();
export const Timestamp = z.string().datetime();
export const RevisionNumber = z.number().int().nonnegative();
export const Money = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), micros: z.number().int().nonnegative().safe(), currency: z.literal("USD"), source: z.string().min(1), verifiedAt: Timestamp }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1) }).strict(),
]);
export type Money = z.infer<typeof Money>;
export const Size = z.object({ width: z.number().int().min(512).max(2048), height: z.number().int().min(512).max(2048) }).strict();
export const Box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) }).strict().refine(b => b.x + b.w <= 1 && b.y + b.h <= 1, "Box must fit inside canvas");
export const RecordMeta = { id: Id, projectId: Id, revision: RevisionNumber, createdAt: Timestamp };
export const Limits = Object.freeze({ uploadBytes: 10 * 1024 * 1024, uploadPixels: 16_000_000, jsonBytes: 64 * 1024, previewTtlMs: 900_000, activeRuns: 1, leaseMs: 60_000, pollMs: 2_000 });
