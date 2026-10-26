import { loadConfig } from "../src/server/config";
import { migrateDatabase } from "../src/infrastructure/persistence/migrate";
migrateDatabase(loadConfig(process.env).databasePath);
console.log("SQLite migrations applied");
