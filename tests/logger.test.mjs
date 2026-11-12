import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LogService } from "../apps/server/dist/logger.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { createConfigStore } from "../apps/server/dist/config.js";
import { createSecretStore } from "../apps/server/dist/model-secret.js";
import { ModelService } from "../apps/server/dist/model.js";

async function serverFixture(t, logs) {
  const server = createStardustServer({ logService: logs });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function readUntil(reader, marker) {
  const decoder = new TextDecoder(); let text = "";
  const task = (async () => { while (!text.includes(marker)) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); } return text; })();
  return Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 3000).unref())]);
}

test("all levels share console and bounded history, with redaction and truncation", () => {
  const output = []; const logs = new LogService(3, (line) => output.push(line));
  for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) logs.write(level, "test", `${level} message`);
  assert.equal(output.length, 4);
  assert.deepEqual(logs.read().entries.map((entry) => entry.level), ["INFO", "WARN", "ERROR"]);
  assert.equal(logs.read(1).gap, false); assert.equal(logs.read(0).entries.length, 3);
  const last = logs.read().entries.at(-1); assert.match(output.at(-1), new RegExp(`#${last.id} ERROR \\[test\\] ${last.message}`));
  logs.write("ERROR", "test", `Authorization: Bearer hidden-value ${"a".repeat(1000)}`, { code: "invalid_key", message: "appSecret=hidden-secret", requestId: "req-1" }, ["hidden-secret", "hidden-value"]);
  const record = JSON.stringify(logs.read().entries.at(-1));
  assert.doesNotMatch(record + output.at(-1), /hidden-secret|hidden-value|Authorization/i);
  logs.write("INFO", "test", "x".repeat(2000)); assert.ok(logs.read().entries.at(-1).message.length <= 512);
  assert.equal(logs.read(1).gap, true);
  const throwing = new LogService(2, () => { throw new Error("console unavailable"); });
  assert.doesNotThrow(() => throwing.write("INFO", "test", "safe")); assert.equal(throwing.read().entries.length, 1);
});

test("history and SSE replay use cursors, reconnect without duplicates and close with the server", async (t) => {
  const logs = new LogService(10, () => {}); const { server, origin } = await serverFixture(t, logs);
  logs.write("INFO", "test", "first");
  let response = await fetch(`${origin}/api/v1/logs`); const history = await response.json();
  assert.equal(history.entries[0].message, "first"); assert.equal(history.latest, 1);
  assert.equal((await fetch(`${origin}/api/v1/logs`, { headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await fetch(`${origin}/api/v1/logs?after=-1`)).status, 400);
  response = await fetch(`${origin}/api/v1/logs/stream?after=1&instance=${history.instanceId}`);
  const reader = response.body.getReader();
  logs.write("WARN", "test", "second");
  const first = await readUntil(reader, '"message":"second"'); assert.match(first, /id: 2/); assert.doesNotMatch(first, /"message":"first"/);
  await reader.cancel();
  logs.write("ERROR", "test", "third");
  response = await fetch(`${origin}/api/v1/logs/stream?after=0&instance=${history.instanceId}`, { headers: { "Last-Event-ID": "2" } });
  const nextReader = response.body.getReader(); const replay = await readUntil(nextReader, '"message":"third"');
  assert.match(replay, /id: 3/); assert.doesNotMatch(replay, /"message":"second"/);
  const closed = new Promise((resolve) => server.close(resolve));
  for (;;) { const rest = await nextReader.read(); if (rest.done) break; }
  await closed;
});

test("slow SSE readers are disconnected and unsubscribed", async (t) => {
  class TrackedLogs extends LogService {
    active = 0; subscribed = false;
    subscribe(callback) { this.active++; this.subscribed = true; const remove = super.subscribe(callback); return () => { this.active--; remove(); }; }
  }
  const logs = new TrackedLogs(1000, () => {}); const { origin } = await serverFixture(t, logs);
  for (let i = 0; i < 1000; i++) logs.write("DEBUG", "test", "x".repeat(500));
  const request = get(`${origin}/api/v1/logs/stream`, (response) => { response.pause(); });
  request.on("error", () => {});
  for (let i = 0; i < 100 && !logs.subscribed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  for (let i = 0; i < 2000 && logs.active; i++) logs.write("DEBUG", "test", "y".repeat(500));
  for (let i = 0; i < 100 && logs.active; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  request.destroy();
  assert.equal(logs.subscribed, true); assert.equal(logs.active, 0);
});

test("a large replay drains to a fast client and reports evicted or restarted history", async (t) => {
  const logs = new LogService(1000, () => {}); const { origin } = await serverFixture(t, logs);
  for (let i = 0; i < 1050; i++) logs.write("DEBUG", "test", "x".repeat(500));
  let response = await fetch(`${origin}/api/v1/logs/stream?after=1`);
  const reader = response.body.getReader();
  const text = await readUntil(reader, "id: 1050\n");
  assert.match(text, /event: gap/); assert.match(text, /id: 51\n/); assert.match(text, /id: 1050\n/);
  await reader.cancel();
  response = await fetch(`${origin}/api/v1/logs/stream?after=10&instance=old-process`);
  assert.match(await response.text(), /event: reset/);
});

test("model failure logs keep safe diagnostic fields and never include credentials or prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-logs-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createConfigStore(root); const secrets = createSecretStore(root, {}); const output = [];
  const logs = new LogService(30, (line) => output.push(line));
  const upstream = createServer((_request, response) => { response.writeHead(401, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { code: "invalid_api_key", message: "bad secret-key-value for private conversation" } })); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(async () => { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const model = new ModelService(store, secrets, fetch, logs);
  model.saveConfig({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, modelId: "mock", timeoutMs: 1000, stream: false, keyAction: "set", apiKey: "secret-key-value" });
  await assert.rejects(model.chat("private conversation"));
  const error = logs.read().entries.find((entry) => entry.level === "ERROR");
  assert.equal(error.details.status, 401); assert.equal(error.details.code, "invalid_api_key");
  assert.doesNotMatch(JSON.stringify(logs.read()) + output.join(""), /secret-key-value|private conversation/);
});
