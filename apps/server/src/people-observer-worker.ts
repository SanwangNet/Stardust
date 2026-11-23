import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { PeopleRepository } from "./people.js";
import type { ChannelObservation } from "./channel.js";

const path: unknown = workerData?.path;
if (typeof path !== "string" || !path || path === ":memory:" || !parentPort) throw new Error("OBSERVER_UNAVAILABLE");
if (!statSync(path).isFile()) throw new Error("OBSERVER_UNAVAILABLE");
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250;");
if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 9) throw new Error("OBSERVER_SCHEMA_UNAVAILABLE");
const port = parentPort;
port.on("message", (job: { observation: ChannelObservation; cancellation: SharedArrayBuffer }) => {
  try {
    const flag = new Int32Array(job.cancellation);
    if (Atomics.load(flag, 0) !== 0) { port.postMessage({ ok: true }); return; }
    const people = new PeopleRepository(db, () => { if (Atomics.load(flag, 0) !== 0) throw new Error("OBSERVATION_CANCELLED"); });
    if (job.observation.kind === "identity") people.observeIdentity(job.observation.value);
    else if (job.observation.kind === "space_member") people.observeSpaceMember(job.observation.value);
    else throw new Error("INVALID_OBSERVATION");
    port.postMessage({ ok: true });
  } catch { port.postMessage({ ok: false }); }
});
