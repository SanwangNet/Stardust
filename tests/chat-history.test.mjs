import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChatHistory, chatHistoryKey, readChatHistory } from "../apps/web/dist/chat-history.js";

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("聊天记录恢复、跨写入合并，Tool 回复不重复", () => {
  const storage = memoryStorage();
  const user = { id: "1", role: "user", content: "你好" };
  const reply = { id: "tool:run-1", role: "model", content: "你好！" };
  assert.deepEqual(readChatHistory(storage), []);
  appendChatHistory(storage, user);
  appendChatHistory(storage, reply);
  appendChatHistory(storage, reply);
  assert.deepEqual(readChatHistory(storage), [user, reply]);
});

test("损坏或不可用的存储不会被覆盖", () => {
  const storage = memoryStorage();
  storage.setItem(chatHistoryKey, "not json");
  assert.throws(() => appendChatHistory(storage, { id: "1", role: "user", content: "hello" }));
  assert.equal(storage.getItem(chatHistoryKey), "not json");
  assert.throws(() => readChatHistory({ getItem() { throw new Error("blocked"); } }));
});
