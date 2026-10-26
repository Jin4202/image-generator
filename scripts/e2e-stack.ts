/**
 * T12 E2E stack: isolated temp APP_DATA_DIR → migration → production build → worker + `next start` children.
 * Never touches the default ./data DB. On SIGINT/SIGTERM (or if either child dies) both children stop and the temp
 * directory is removed. Mock provider only; FAL_KEY is a non-secret sentinel so tests can prove it never reaches clients
 * (tests repeat the literal: importing this file would start a stack).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDatabase } from "../src/infrastructure/persistence/migrate";

const port = process.env.E2E_PORT ?? "3100";
const E2E_KEY_SENTINEL = "e2e-sentinel-fal-key-never-in-client";
const dataDir = mkdtempSync(join(tmpdir(), "studio-e2e-"));
const env = { ...process.env, APP_DATA_DIR: dataDir, GENERATION_PROVIDER: "mock", FAL_KEY: E2E_KEY_SENTINEL, NEXT_TELEMETRY_DISABLED: "1" };
const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 8000;
  const finish = () => {
    if (children.some(c => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) return void setTimeout(finish, 100);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
  };
  finish();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function start(name: string, command: string, args: string[]) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  child.on("exit", (code, signal) => { if (!stopping) { console.error(`[e2e-stack] ${name} exited (${signal ?? code}); stopping stack`); stop(1); } });
  children.push(child);
}

migrateDatabase(join(dataDir, "studio.sqlite"));
console.log("[e2e-stack] migrated isolated database");
if (process.env.E2E_SKIP_BUILD !== "1") {
  const build = spawnSync("npx", ["next", "build", "--webpack"], { env, stdio: "inherit" });
  if (build.status !== 0) { rmSync(dataDir, { recursive: true, force: true }); process.exit(build.status ?? 1); }
}
start("worker", "npx", ["tsx", "src/worker/main.ts"]);
start("next", "npx", ["next", "start", "--hostname", "127.0.0.1", "--port", port]);
