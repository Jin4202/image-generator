# ADR 005 — local fal key/mode settings (T16)
Status: accepted 2026-10-26 (race control option A approved by the user; see docs/blockers.md T16).

## Context
Users want to enter the fal API key in the app instead of exporting shell variables for two processes (Next server and worker). The key is a global local secret, not project data. Switching provider or key while runs are active could poll an old request with another account or fail a paid run, and a check-then-write in the HTTP handler races with new submits.

## Decision
- Storage: `APP_DATA_DIR/settings/settings.json` (`{version:1, mode, falKey?}`), directory 0700, file 0600, synchronous temp-file + rename; a failed write keeps the previous file. Plain text on the local disk; the UI and README say so. Never in the DB, workspace, manifest, logs, responses, localStorage or cookies. A symlinked settings directory is refused.
- Precedence: explicit env (`GENERATION_PROVIDER`, `FAL_KEY`) > settings file > mock. The UI shows when env wins and cannot edit or delete env values.
- Apply on restart only: server container and worker read env + file once at start. The running server never switches provider from the file (no hot reload). Saving never calls fal; "saved" is not "verified".
- Serialization (in-process gate): run creation happens only in the Next server process, and `submitRun` checks `deps.adapters` inside its synchronous transaction. A change first empties the shared adapter map (closing generation), then a synchronous transaction refuses any active run with CONFLICT, then the file is replaced synchronously; failures reopen the gate. If the next start differs from the running config, the gate stays closed until restart (all models `RESTART_REQUIRED`, health `restartRequired`).
- Worker: re-reads the effective settings every 2s; if they differ from its start config (or cannot be read) it stops taking ticks, releases the lease, closes the DB and exits asking for a restart.

## Consequences
Single-server-process assumption (this is a local single-user app); several Next processes on one data dir are not serialized against each other. Restart is required for both processes. A DB settings revision checked by `submitRun` (option B) would serialize across processes but changes the runs contract and migration baseline; revisit if multi-process serving is ever supported.
