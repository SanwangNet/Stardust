import { parentPort, workerData } from "node:worker_threads";
import { ConversationService } from "../../apps/server/dist/conversation.js";
try {
  const store = new ConversationService({ chatContext: async () => "unused" }, workerData.path);
  const result = store.people.observeIdentity(workerData.input);
  store.close(); parentPort.postMessage({ personId: result.personId, identityId: result.id });
} catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : "FAILED" }); }
