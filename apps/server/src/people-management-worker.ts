import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { recordQQ } from "./history-provenance.js";
import type { ChannelMessage } from "./channel.js";
import { PeopleRepository } from "./people.js";
import { queryPeople, mutatePeople, type ManagementArgs, type ManagementQuery, type ManagementMutation } from "./people-management.js";

try {
  const db = new DatabaseSync(workerData.path as string, { readOnly: !workerData.mutation && !workerData.history });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250;");
    if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 11) throw new Error("UNSUPPORTED_SCHEMA");
    if (workerData.history) {
      const history = workerData.history as { message: ChannelMessage; reply?: string };
      recordQQ(db, history.message, history.reply); parentPort?.postMessage({ ok: true });
    } else {
    const repo = new PeopleRepository(db);
    const value = workerData.mutation ? mutatePeople(repo, workerData.query as ManagementMutation, workerData.args as unknown[]) : queryPeople(repo, workerData.query as ManagementQuery, workerData.args as ManagementArgs);
    parentPort?.postMessage({ ok: true, value });
    }
  } finally { db.close(); }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error && ["NOT_FOUND", "INVALID_INPUT", "CONFLICT", "BATCH_LIMIT"].includes(error.message) ? error.message : "PEOPLE_UNAVAILABLE" });
}
