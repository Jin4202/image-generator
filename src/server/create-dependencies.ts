import { randomUUID } from "node:crypto";
import type { Dependencies, ModelAdapter } from "../application/ports";
import type { Compiled } from "../contracts";
import { createSharpImageCompositor } from "../infrastructure/images/compositor";
import { createSharpImageInspector } from "../infrastructure/images/sharp";
import { createFalAdapter } from "../infrastructure/models/fal";
import { MockAdapter } from "../infrastructure/models/mock";
import { openRepository } from "../infrastructure/persistence/repository";
import { createLocalBlobStore } from "../infrastructure/storage/local";
import type { loadConfig } from "./config";

/**
 * T12: framework-neutral factory shared by worker and server-only container.
 * Opens an already migrated database (missing schema → explicit STORAGE error; never migrates implicitly).
 * The mock adapter is always available; fal adapters are added only in fal mode with a key.
 */
export function createDependencies(config: ReturnType<typeof loadConfig>): Dependencies {
  const repo = openRepository(config.databasePath);
  const adapters = new Map<Compiled["adapterId"], ModelAdapter>([["mock-reference", new MockAdapter()]]);
  if (config.provider === "fal" && config.falKey) {
    for (const id of ["fal-flux2-edit", "fal-flux2-text"] as const) adapters.set(id, createFalAdapter(id, config.falKey));
  }
  return {
    repo,
    blobs: createLocalBlobStore(config.dataDir),
    imageInspector: createSharpImageInspector(),
    imageCompositor: createSharpImageCompositor(),
    adapters,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
}
