import type { Dependencies } from "../../src/application/ports";
import { unfinished } from "../../src/domain/errors";
import { createSharpImageCompositor } from "../../src/infrastructure/images/compositor";
import { createSharpImageInspector } from "../../src/infrastructure/images/sharp";
import { MockAdapter } from "../../src/infrastructure/models/mock";
import { now } from "./fixtures";
/** Fail loudly on undeclared effects; acceptance tests install real repositories as needed. Image inspection/compositing are pure CPU, so the real sharp implementations are the defaults. */
export function testDependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  let sequence = 100;
  return { repo: { get: () => unfinished("TEST_REPO"), list: () => unfinished("TEST_REPO"), insert: () => unfinished("TEST_REPO"), replace: () => unfinished("TEST_REPO"), transaction: () => unfinished("TEST_REPO"), acquireLease: () => unfinished("TEST_REPO"), releaseLease: () => unfinished("TEST_REPO"), deleteProject: () => unfinished("TEST_REPO"), close: () => {} }, blobs: { write: async () => unfinished("TEST_BLOBS"), read: async () => unfinished("TEST_BLOBS") }, imageInspector: createSharpImageInspector(), imageCompositor: createSharpImageCompositor(), adapters: new Map([["mock-reference", new MockAdapter()]]), now: () => now, newId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12,"0")}`, ...overrides };
}
