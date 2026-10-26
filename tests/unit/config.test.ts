import { expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";
it("defaults to mock and validates live credentials", () => { expect(loadConfig({}).provider).toBe("mock");expect(() => loadConfig({GENERATION_PROVIDER:"fal"})).toThrow("FAL_KEY");expect(() => loadConfig({GENERATION_PROVIDER:"false"})).toThrow(); });
