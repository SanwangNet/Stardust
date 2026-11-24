import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { PeopleRepository } from "./people.js";
import { resolveIdentity, type IdentityInput } from "./identity-resolver.js";
try {
  const db = new DatabaseSync(workerData.path as string, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=250; BEGIN");
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 11) throw new Error("SCHEMA_UNAVAILABLE");
    const result = resolveIdentity(new PeopleRepository(db), workerData.input as IdentityInput);
    db.exec("COMMIT"); parentPort?.postMessage(result);
  } finally { db.close(); }
} catch { parentPort?.postMessage({ kind: "unavailable" }); }
