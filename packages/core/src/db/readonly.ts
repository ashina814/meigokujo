import Database from "better-sqlite3";

/**
 * Opens an existing SQLite database without running migrations or allowing writes.
 * Intended for diagnostics, exports, and analysis snapshots.
 */
export function openReadonlyDb(path: string): Database.Database {
  if (path === ":memory:") {
    throw new Error("A read-only scan requires a file-backed SQLite database");
  }

  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  return db;
}
