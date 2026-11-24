import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { searchScopedHistory, type HistoryRunContext } from "./scoped-history-search.js";
try {
  const db = new DatabaseSync(workerData.path as string,{readOnly:true});
  try { db.exec("PRAGMA busy_timeout=250; BEGIN"); if(Number(db.prepare("PRAGMA user_version").get()?.user_version)!==11) throw new Error("HISTORY_UNAVAILABLE"); const result=searchScopedHistory(db,workerData.context as HistoryRunContext,workerData.input); db.exec("COMMIT"); parentPort?.postMessage({result}); }
  finally { db.close(); }
} catch(error) { const code=error instanceof Error ? error.message : ""; parentPort?.postMessage({error:["INVALID_SEARCH","HISTORY_SOURCE_UNAVAILABLE","HISTORY_ACCESS_DENIED"].includes(code) ? code : "HISTORY_UNAVAILABLE"}); }
