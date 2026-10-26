import type { Asset, Candidate, Compiled, Effects, Experiment, ExportRecord, Media, Preview, Project, Review, Run, Scene, Style } from "../contracts";
export interface Entities { projects: Project; media: Media; styles: Style; assets: Asset; scenes: Scene; previews: Preview; runs: Run; candidates: Candidate; reviews: Review; effects: Effects; exports: ExportRecord; experiments: Experiment }
export type EntityKind = keyof Entities;
/** Synchronous transaction only. Never await / perform network or filesystem I/O inside it. */
export interface UnitOfWork {
  get<K extends EntityKind>(kind: K, id: string): Entities[K] | null;
  list<K extends EntityKind>(kind: K, projectId?: string): Entities[K][];
  insert<K extends EntityKind>(kind: K, value: Entities[K]): void;
  replace<K extends EntityKind>(kind: K, value: Entities[K], expectedRevision: number): void;
  acquireLease(owner: string, now: string, until: string): boolean;
  releaseLease(owner: string): void;
}
export interface Repository extends UnitOfWork {
  transaction<T>(work: (tx: UnitOfWork) => T): T;
  close(): void;
}
export interface StoredBytes { relativePath: string; sha256: string; bytes: number }
export interface BlobStore {
  write(bytes: Uint8Array, extension: "png" | "jpeg" | "webp" | "json"): Promise<StoredBytes>;
  read(relativePath: string): Promise<Uint8Array>;
}
export interface ImageInfo { mime: string; width: number; height: number; pages: number }
/** Fully decodes (not header-only) images within Limits.uploadPixels; larger ones are reported from the header so callers reject them. Undecodable bytes → AppError INVALID_MEDIA. Never mutates bytes. */
export interface ImageInspector {
  inspect(bytes: Uint8Array): Promise<ImageInfo>;
}
export type CompositeLayer = { bytes: Uint8Array; layer: { x: number; y: number; scale: number; rotation: number; opacity: number } };
export interface CompositeInput { base: Uint8Array; adjustments: { brightness: number; contrast: number; saturation: number; blur: number }; overlays: readonly CompositeLayer[] }
/**
 * Renders an export PNG (sRGB RGBA, base size, no crop/resize of the base). Base RGB only, alpha kept:
 * brightness ×b → contrast c·v+128(1−c) → saturation ×s → blur (0 skips, 0<σ<0.3 → 0.3). Then overlays in the given
 * order (caller sorts by zIndex, ties by array order): scale → rotate clockwise about own center → opacity, placed with
 * the transformed bounding box's top-left at rounded (x, y) in base pixels, clipped to the canvas, source-over.
 * Identity adjustments with no overlays reproduce the base pixels exactly. Undecodable input → AppError INVALID_MEDIA.
 */
export interface ImageCompositor {
  composite(input: CompositeInput): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}
export type ProviderOutput = { bytes: Uint8Array; mime: "image/png"; seed: number | null };
export type ProviderStatus = { status: "queued" | "running" } | { status: "failed"; code: string } | { status: "completed" };
export interface ModelAdapter {
  readonly id: Compiled["adapterId"];
  submit(input: Compiled, references: readonly Uint8Array[]): Promise<{ requestId: string }>;
  poll(requestId: string): Promise<ProviderStatus>;
  download(requestId: string): Promise<ProviderOutput[]>;
}
export interface Dependencies {
  repo: Repository;
  blobs: BlobStore;
  imageInspector: ImageInspector;
  imageCompositor: ImageCompositor;
  adapters: ReadonlyMap<Compiled["adapterId"], ModelAdapter>;
  now(): string;
  newId(): string;
}
