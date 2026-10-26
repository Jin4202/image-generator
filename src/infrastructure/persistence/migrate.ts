import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
/** Shared infrastructure implemented. Repository behavior remains T01. */
export function migrateDatabase(path: string, directory = resolve("db/migrations")): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON"); db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)");
    for (const name of readdirSync(directory).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort()) {
      const sql = readFileSync(resolve(directory, name), "utf8"); const hash = createHash("sha256").update(sql).digest("hex");
      db.transaction(() => {
        const existing = db.prepare("SELECT sha256 FROM schema_migrations WHERE name=?").get(name) as { sha256: string } | undefined;
        if (existing) { if (existing.sha256 !== hash) throw new Error(`Migration checksum mismatch: ${name}`); return; }
        db.exec(sql); db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(name, hash);
      })();
    }
  } finally { db.close(); }
}
