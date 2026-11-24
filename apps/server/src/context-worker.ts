import { DatabaseSync } from "node:sqlite";
import { parentPort,workerData } from "node:worker_threads";
import { prepareQQContext } from "./context-service.js";
import { recordQQ } from "./history-provenance.js";
try {
 const db=new DatabaseSync(workerData.path as string);
 try {db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250"); if(Number(db.prepare("PRAGMA user_version").get()?.user_version)!==9)throw new Error("CONTEXT_UNAVAILABLE");
  const value=workerData.operation==='prepare'?prepareQQContext(db,workerData.message):recordQQ(db,workerData.message,workerData.reply,workerData.status);
  parentPort?.postMessage({ok:true,value});
 } finally {db.close();}
} catch {parentPort?.postMessage({ok:false});}
