import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateDatabase } from "../../src/infrastructure/persistence/migrate";
it("migrates twice, enforces project FK and idempotency constraints", () => {
 const root=mkdtempSync(join(tmpdir(),"studio-migration-")); const path=join(root,"db.sqlite");
 try { migrateDatabase(path);migrateDatabase(path);const db=new Database(path);try {
 db.pragma("foreign_keys = ON");expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({n:1});
 expect(() => db.prepare("INSERT INTO scenes VALUES ('s','missing',0,'{}')").run()).toThrow();
 db.prepare("INSERT INTO projects VALUES ('p',0,'{}')").run();db.prepare("INSERT INTO previews VALUES ('v','p',0,'{}')").run();
 db.prepare("INSERT INTO runs VALUES ('r','p',0,'{}','v','k')").run();
 expect(() => db.prepare("INSERT INTO runs VALUES ('r2','p',0,'{}','v','k2')").run()).toThrow();
 } finally {db.close();} } finally {rmSync(root,{recursive:true,force:true});}
});
