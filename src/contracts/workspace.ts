import { z } from "zod";
import { Project, Media, Style, Asset, Scene, Review, Effects, ExportRecord } from "./studio";
import { Run, Candidate, Experiment } from "./generation";
export const Workspace = z.object({ project: Project, media: z.array(Media), styles: z.array(Style), assets: z.array(Asset), scenes: z.array(Scene), runs: z.array(Run), candidates: z.array(Candidate), reviews: z.array(Review), effects: z.array(Effects), exports: z.array(ExportRecord), experiments: z.array(Experiment) }).strict();
export const Manifest = z.object({ schemaVersion: z.literal(1), exportedAt: z.string().datetime(), candidateId: z.string().uuid(), workspace: Workspace, files: z.array(z.object({ mediaId: z.string().uuid(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();
export type Workspace = z.infer<typeof Workspace>;
export type Manifest = z.infer<typeof Manifest>;
