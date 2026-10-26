import { z } from "zod";

/** T16: generation provider mode. The fal key is a global local setting, never project data. */
export const ProviderMode = z.enum(["mock", "fal"]);
export type ProviderMode = z.infer<typeof ProviderMode>;

/** PUT /api/settings/fal. `key` omitted = keep the stored key; when present it must be a non-empty printable token. */
export const FalSettingsInput = z.object({ mode: ProviderMode, key: z.string().regex(/^[\x21-\x7e]{1,500}$/).optional() }).strict();
export type FalSettingsInput = z.infer<typeof FalSettingsInput>;

/**
 * GET/PUT/DELETE /api/settings/fal response. Never contains the key. "Saved" is not "authenticated": no fal call is made.
 * - configured/source: whether a key will be available at the next start and where it comes from (env wins over file).
 * - savedMode: mode stored in the settings file (mock when none); modeSource: what decides the mode at the next start.
 * - serverMode: mode of the running server; restartRequired: the next start differs from what is running, so new
 *   generations are refused until the server and the worker are both restarted.
 */
export const FalSettings = z.object({
  configured: z.boolean(),
  source: z.enum(["env", "file", "none"]),
  savedMode: ProviderMode,
  modeSource: z.enum(["env", "file", "default"]),
  serverMode: ProviderMode,
  restartRequired: z.boolean(),
}).strict();
export type FalSettings = z.infer<typeof FalSettings>;
