import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Repository } from "../application/ports";
import { FalSettings, type FalSettingsInput } from "../contracts";
import { AppError } from "../domain/errors";
import { transitions } from "../domain/run-state";
import { loadConfig, sameRuntime, type AppConfig, type StoredSettings } from "./config";

/**
 * T16: global local fal settings. Framework-neutral (the worker imports it). Plain-text JSON in a private directory under
 * APP_DATA_DIR (dir 0700, file 0600, atomic replace). Never in the DB, workspace, manifest, logs or the browser.
 */
const Stored = z.object({ version: z.literal(1), mode: z.enum(["mock", "fal"]), falKey: z.string().regex(/^[\x21-\x7e]{1,500}$/).optional() }).strict();
const settingsDir = (dataDir: string) => join(dataDir, "settings");
const settingsFile = (dataDir: string) => join(settingsDir(dataDir), "settings.json");
const dataDirOf = (env: Record<string, string | undefined>) => resolve(env.APP_DATA_DIR || "./data");

/** null when no file exists. A malformed file is an error (fixed message, no path or content). */
export function readSettingsFile(dataDir: string): StoredSettings | null {
  let text: string;
  try { text = readFileSync(settingsFile(dataDir), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new AppError("STORAGE", "Settings file could not be read"); }
  let parsed: z.infer<typeof Stored>;
  try { parsed = Stored.parse(JSON.parse(text)); } catch { throw new AppError("STORAGE", "Settings file is invalid; save the settings again or delete the file"); }
  return parsed.falKey ? { mode: parsed.mode, falKey: parsed.falKey } : { mode: parsed.mode };
}

/** Synchronous atomic replace: a failed write leaves the previous file untouched. */
export function writeSettingsFile(dataDir: string, value: StoredSettings): void {
  const dir = settingsDir(dataDir);
  const temp = join(dir, `.settings-${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("symlinked settings directory");
    chmodSync(dir, 0o700);
    const fd = openSync(temp, "wx", 0o600);
    try { writeSync(fd, `${JSON.stringify({ version: 1, ...value })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, settingsFile(dataDir));
  } catch {
    rmSync(temp, { force: true });
    throw new AppError("STORAGE", "Settings could not be saved; the previous settings are unchanged");
  }
}

/** env + settings file, as the server and the worker read them at start. */
export function loadEffectiveConfig(env: Record<string, string | undefined>): AppConfig {
  return loadConfig(env, readSettingsFile(dataDirOf(env)));
}

/** What the settings route needs from the running server (provided by the server-only container). */
export interface SettingsHost {
  env: Record<string, string | undefined>;
  repo: Repository;
  /** Config the running server was built with. */
  loaded: AppConfig;
  /** Stops new generations in this process until the returned release is called (or for good after a restart is pending). */
  closeGeneration(): () => void;
  setRestartPending(pending: boolean): void;
}

export function describeFalSettings(host: Pick<SettingsHost, "env" | "loaded">): FalSettings {
  const dataDir = dataDirOf(host.env);
  const stored = readSettingsFile(dataDir);
  let next: AppConfig | null;
  try { next = loadConfig(host.env, stored); } catch { next = null; }
  return FalSettings.parse({
    configured: Boolean(next?.falKey ?? host.env.FAL_KEY ?? stored?.falKey),
    source: host.env.FAL_KEY ? "env" : stored?.falKey ? "file" : "none",
    savedMode: stored?.mode ?? "mock",
    modeSource: host.env.GENERATION_PROVIDER ? "env" : stored ? "file" : "default",
    serverMode: host.loaded.provider,
    restartRequired: next === null || !sameRuntime(host.loaded, next),
  });
}

/**
 * Serialized change (decision 2026-10-26, docs/blockers.md T16): close generation in this process first, then a synchronous
 * transaction refuses any active run (unknown/download_failed included), then the file is replaced synchronously, so no
 * submit can interleave. Any failure reopens generation and keeps the old file. Success keeps generation closed until restart
 * when the next start differs from what is running. No fal call is made: "saved" never means "key verified".
 */
function changeSettings(host: SettingsHost, next: (current: StoredSettings | null) => StoredSettings): FalSettings {
  const dataDir = dataDirOf(host.env);
  const release = host.closeGeneration();
  try {
    const value = next(readSettingsFile(dataDir));
    const active = host.repo.transaction(tx => tx.list("runs").some(run => transitions[run.status].length > 0));
    if (active) throw new AppError("CONFLICT", "A generation is still active (including unknown or failed downloads); resolve it before changing provider settings");
    writeSettingsFile(dataDir, value);
    const view = describeFalSettings(host);
    host.setRestartPending(view.restartRequired);
    return view;
  } finally {
    release();
  }
}

export function updateFalSettings(host: SettingsHost, input: FalSettingsInput): FalSettings {
  return changeSettings(host, current => {
    const falKey = input.key ?? current?.falKey;
    if (input.mode === "fal" && !falKey && !host.env.FAL_KEY) throw new AppError("VALIDATION", "fal mode needs an API key");
    return falKey ? { mode: input.mode, falKey } : { mode: input.mode };
  });
}

/** Removes the stored key and stores mock mode; an env FAL_KEY is outside the UI's control and stays. */
export function deleteFalSettings(host: SettingsHost): FalSettings {
  return changeSettings(host, () => ({ mode: "mock" }));
}
