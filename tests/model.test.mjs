import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfigStore } from "../apps/server/dist/config.js";
import { createSecretStore } from "../apps/server/dist/model-secret.js";
import { createEnvLoader } from "../apps/server/dist/env.js";
import { ModelService } from "../apps/server/dist/model.js";
import { collectModelStream } from "../apps/server/dist/model-stream.js";
import { safeTarget } from "../apps/server/dist/model-diagnostics.js";
import { SetupService } from "../apps/server/dist/setup.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { formatModelError, noModelResponseMessage } from "../apps/web/dist/model-errors.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "stardust-model-"));
  const store = createConfigStore(root);
  const processEnv = {};
  const secrets = createSecretStore(root, processEnv);
  const model = new ModelService(store, secrets);
  const setup = new SetupService(store);
  let mode = "ok";
  let lastRequest;
  let upstreamClosed = false;
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      lastRequest = { path: req.url, authorization: req.headers.authorization, accept: req.headers.accept, body: JSON.parse(body) };
      if (mode === "timeout") return;
      if (mode.startsWith("sse-")) {
        res.writeHead(200, { "Content-Type": mode === "sse-wrong-type" ? "text/plain" : "text/event-stream; charset=utf-8", "X-Request-ID": "req-stream" });
        if (mode === "sse-valid") {
          const data = Buffer.from(': heartbeat\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\ndata:{"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n');
          const position = data.indexOf(Buffer.from("你"));
          const chunks = [data.subarray(0, 3), data.subarray(3, position + 1), data.subarray(position + 1, position + 2), data.subarray(position + 2)];
          for (const chunk of chunks) res.write(chunk);
          res.end();
        } else if (mode === "sse-error") {
          res.end('event: error\ndata: {"error":{"code":"stream_overloaded","message":"The model is busy."}}\n\n');
        } else if (mode === "sse-error-secret") {
          res.end('data: {"error":{"code":"invalid_request","message":"Authorization: Bearer private-key"}}\n\n');
        } else if (mode === "sse-truncated") {
          res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        } else if (mode === "sse-disconnect") {
          res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
          setTimeout(() => res.destroy(), 30);
        } else if (mode === "sse-timeout" || mode === "sse-stall") {
          if (mode === "sse-stall") res.on("close", () => { upstreamClosed = true; });
          res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        } else if (mode === "sse-large") {
          res.end(`data: ${"x".repeat(1100000)}\n\n`);
        } else if (mode === "sse-invalid") {
          res.end('data: {not json}\n\ndata: [DONE]\n\n');
        } else {
          res.end('data: [DONE]\n\n');
        }
        return;
      }
      if (mode.startsWith("structured-")) {
        const status = Number(mode.slice("structured-".length));
        res.writeHead(status, { "Content-Type": "application/json", "X-Request-ID": "req-safe-123" });
        res.end(JSON.stringify({ error: { code: `upstream_${status}`, message: `上游故障 ${status}` } }));
        return;
      }
      if (mode === "unsafe") {
        res.writeHead(401, { "Content-Type": "application/json", "X-Request-ID": "private-key" });
        res.end(JSON.stringify({ error: { code: "private-key", message: "Authorization: Bearer private-key; Cookie: session=hidden; user message: sensitive-prompt" } }));
        return;
      }
      if (mode === "echo-prompt") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_request", message: `Rejected: ${lastRequest.body.messages[0].content}; api_key=private-key` } }));
        return;
      }
      if (mode === "partial-prompt") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_request", message: "Rejected: conversation" } }));
        return;
      }
      if (mode === "plain") { res.writeHead(503, { "Content-Type": "text/plain" }); res.end("Service is temporarily unavailable."); return; }
      if (mode === "nonstandard") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ code: "custom_error", type: "invalid_request", message: "Invalid model setting." }] }));
        return;
      }
      if (mode === "empty") { res.writeHead(500); res.end(); return; }
      if (/^\d+$/.test(mode)) { res.writeHead(Number(mode)); res.end('secret-error-from-upstream'); return; }
      if (mode === "invalid") { res.end('{bad json'); return; }
      if (mode === "large") { res.end(JSON.stringify({ choices: [{ message: { content: "x".repeat(1100000) } }] })); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: mode === "echo-secret" ? req.headers.authorization : "模拟回复" } }] }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const server = createStardustServer({ setupService: setup, modelService: model });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((done) => server.close(done)), new Promise((done) => upstream.close(done))]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, secrets, processEnv, model, setup, origin, upstreamUrl, mode: (value) => { mode = value; }, last: () => lastRequest, upstreamClosed: () => upstreamClosed };
}
function post(origin, path, input, headers = {}) {
  return fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) });
}
const options = (baseUrl, extra = {}) => ({ baseUrl, modelId: "demo", timeoutMs: 1000, keyAction: "keep", ...extra });

test("密钥增删替换保留其他环境变量和注释，并遵循进程变量优先级", async (t) => {
  const { root, secrets, processEnv } = await fixture(t);
  const original = '# 原注释\nOTHER="第一行\nSTARDUST_MODEL_API_KEY=not-a-setting\n末行"\nexport STARDUST_MODEL_API_KEY=old # 密钥注释\nOTHER2=value # 保留\n';
  await writeFile(join(root, ".env"), original);
  secrets.saveKey("key-one");
  let file = await readFile(join(root, ".env"), "utf8");
  assert.match(file, /# 原注释/);
  assert.match(file, /OTHER="第一行\nSTARDUST_MODEL_API_KEY=not-a-setting\n末行"/);
  assert.match(file, /# 密钥注释/);
  assert.match(file, /OTHER2=value # 保留/);
  assert.equal(secrets.getKey().key, "key-one");
  secrets.saveKey("key-two");
  assert.equal(secrets.getKey().key, "key-two");
  processEnv.STARDUST_MODEL_API_KEY = "process-key";
  assert.equal(secrets.getKey().key, "process-key");
  assert.equal(secrets.getKey().source, "process");
  secrets.saveKey("");
  assert.equal(secrets.getKey().key, "process-key");
  assert.equal(secrets.getKey().fileConfigured, false);
  delete processEnv.STARDUST_MODEL_API_KEY;
  assert.equal(secrets.getKey().key, "");
  file = await readFile(join(root, ".env"), "utf8");
  assert.match(file, /# 密钥注释/);
  assert.match(file, /OTHER2=value # 保留/);
  await writeFile(join(root, ".env"), '\uFEFFSTARDUST_MODEL_API_KEY=first\nOTHER=preserved\n');
  assert.equal(secrets.getKey().key, "first");
  secrets.saveKey("replacement");
  assert.equal(secrets.getKey().key, "replacement");
  secrets.saveKey("");
  assert.equal(secrets.getKey().key, "");
  assert.match(await readFile(join(root, ".env"), "utf8"), /OTHER=preserved/);
  assert.equal(createEnvLoader(root).loadCoreEnv().OTHER, "preserved");
});

test("密钥文件替换失败时明确报错并保留原文件", async (t) => {
  const { root, setup, origin, upstreamUrl } = await fixture(t);
  await setup.completeInitialization({});
  const original = "# preserve\nSTARDUST_MODEL_API_KEY=old\n";
  await writeFile(join(root, ".env"), original);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to).endsWith(".env")) throw new Error("private-internal-detail");
    return rename(from, to);
  });
  const response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { keyAction: "set", apiKey: "new-key" }));
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /SAVE_FAILED/);
  assert.doesNotMatch(body, /new-key|private-internal-detail/);
  assert.equal(await readFile(join(root, ".env"), "utf8"), original);
});

test("初始化保护、配置保存、真实协议请求与密钥脱敏", async (t) => {
  const { root, setup, origin, upstreamUrl, last, mode, processEnv } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/v1/model/config`)).status, 403);
  await setup.completeInitialization({});
  let response = await post(origin, "/api/v1/model/chat", { message: "hello" });
  assert.equal((await response.json()).error.category, "NOT_CONFIGURED");
  assert.equal((await post(origin, "/api/v1/model/config", options(upstreamUrl), { Origin: "https://cross.example" })).status, 403);
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { keyAction: "set", apiKey: "private-key" }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /private-key/);
  assert.doesNotMatch(await readFile(join(root, "config.toml"), "utf8"), /private-key/);
  assert.match(await readFile(join(root, ".env"), "utf8"), /private-key/);
  const config = await (await fetch(`${origin}/api/v1/model/config`)).json();
  assert.equal(config.baseUrl, upstreamUrl);
  assert.equal(config.keyConfigured, true);
  assert.equal(config.stream, false);
  assert.equal(config.keySource, "file");
  assert.doesNotMatch(JSON.stringify(config), /private-key/);
  response = await post(origin, "/api/v1/model/test", {});
  assert.equal(response.status, 200);
  assert.equal(last().path, "/v1/chat/completions");
  assert.equal(last().authorization, "Bearer private-key");
  assert.equal(last().body.model, "demo");
  assert.deepEqual(last().body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal(last().body.stream, false);
  response = await post(origin, "/api/v1/model/chat", { message: "你好" });
  assert.deepEqual(await response.json(), { reply: "模拟回复" });
  mode("echo-secret");
  response = await post(origin, "/api/v1/model/chat", { message: "你好" });
  assert.doesNotMatch(await response.text(), /private-key/);
  processEnv.STARDUST_MODEL_API_KEY = "override-key";
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { keyAction: "set", apiKey: "replacement-key" }));
  const overridden = await response.json();
  assert.equal(overridden.processOverride, true);
  assert.equal(overridden.fileKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(overridden), /override-key|replacement-key/);
  assert.match(await readFile(join(root, ".env"), "utf8"), /replacement-key/);
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { keyAction: "clear" }));
  assert.equal((await response.json()).processOverride, true);
  assert.doesNotMatch(await readFile(join(root, ".env"), "utf8"), /replacement-key/);
});

test("流式配置可保存、读取，连接测试和对话使用相同模式", async (t) => {
  const { root, store, setup, origin, upstreamUrl, last, mode } = await fixture(t);
  await setup.completeInitialization({});
  mode("sse-valid");
  let response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { stream: true }));
  assert.equal((await response.json()).stream, true);
  assert.equal(store.loadConfig().model.stream, true);
  assert.match(await readFile(join(root, "config.toml"), "utf8"), /stream\s*=\s*true/);
  assert.equal((await (await fetch(`${origin}/api/v1/model/config`)).json()).stream, true);
  response = await post(origin, "/api/v1/model/test", {});
  assert.equal(response.status, 200);
  assert.equal(last().body.stream, true);
  assert.equal(last().accept, "text/event-stream");
  response = await post(origin, "/api/v1/model/chat", { message: "hello" });
  assert.deepEqual(await response.json(), { reply: "你好世界" });
  assert.equal(last().body.stream, true);
  // Older callers that omit the new field do not silently disable the current mode.
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl));
  assert.equal((await response.json()).stream, true);
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { stream: "true" }));
  assert.equal(response.status, 400);
  response = await post(origin, "/api/v1/model/config", options(upstreamUrl, { stream: false }));
  assert.equal((await response.json()).stream, false);
});

test("SSE 逐字节跨块、跨 UTF-8 和多行数据均可正确拼接", async () => {
  const source = ': keepalive\r\nevent: ping\ndata: {}\n\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"甲"}},{"delta":{"content":"乙"}}]}\n\ndata: [DONE]';
  const bytes = Buffer.from(source);
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const result = await collectModelStream(response, new AbortController().signal, 1024 * 1024, () => new Error("invalid"), () => new Error("incomplete"), async () => new Error("upstream"));
  assert.equal(result, "中文甲乙");
  const invalidBytes = new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(0xff)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(collectModelStream(invalidBytes, new AbortController().signal, 1024, () => new Error("invalid utf8"), () => new Error("incomplete"), async () => new Error("upstream")), /invalid utf8/);
});

test("流中错误、提前结束、超时、无效数据和大小限制", async (t) => {
  const { setup, origin, upstreamUrl, mode } = await fixture(t);
  await setup.completeInitialization({});
  await post(origin, "/api/v1/model/config", options(upstreamUrl, { stream: true, keyAction: "set", apiKey: "private-key" }));
  mode("sse-error");
  let response = await post(origin, "/api/v1/model/chat", { message: "hello" });
  let data = await response.json();
  assert.equal(data.error.source, "upstream");
  assert.equal(data.error.status, 200);
  assert.equal(data.error.code, "stream_overloaded");
  assert.equal(data.error.message, "The model is busy.");
  assert.equal(data.error.requestId, "req-stream");
  mode("sse-error-secret");
  response = await post(origin, "/api/v1/model/chat", { message: "hello" });
  assert.doesNotMatch(await response.text(), /private-key|Authorization/i);
  for (const [upstream, expected] of [["sse-truncated", "STREAM_INCOMPLETE"], ["sse-disconnect", "CONNECTION_INTERRUPTED"], ["sse-invalid", "INVALID_RESPONSE"], ["sse-empty", "INVALID_RESPONSE"], ["sse-large", "INVALID_RESPONSE"], ["sse-wrong-type", "INVALID_RESPONSE"], ["sse-timeout", "TIMEOUT"]]) {
    mode(upstream);
    response = await post(origin, "/api/v1/model/chat", { message: "hello" });
    data = await response.json();
    assert.equal(data.error.category, expected, upstream);
  }
  mode("structured-400");
  response = await post(origin, "/api/v1/model/test", {});
  data = await response.json();
  assert.equal(data.error.status, 400);
  assert.equal(data.error.code, "upstream_400");
  assert.equal(data.error.message, "上游故障 400");
});

test("取消模型请求会取消上游流并返回取消状态", async (t) => {
  const { store, secrets, model, upstreamUrl } = await fixture(t);
  model.saveConfig(options(upstreamUrl, { stream: true }));
  let cancelled = false;
  const fakeFetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const service = new ModelService(store, secrets, fakeFetch);
  const controller = new AbortController();
  const pending = service.chat("hello", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "REQUEST_CANCELLED");
  assert.equal(cancelled, true);
});

test("HTTP 客户端断开时取消上游流连接", async (t) => {
  const { setup, origin, upstreamUrl, mode, last, upstreamClosed } = await fixture(t);
  await setup.completeInitialization({});
  await post(origin, "/api/v1/model/config", options(upstreamUrl, { stream: true, timeoutMs: 5000 }));
  mode("sse-stall");
  const controller = new AbortController();
  const request = fetch(`${origin}/api/v1/model/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "client cancellation" }), signal: controller.signal }).catch(() => undefined);
  const deadline = Date.now() + 3000;
  while (!last() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(last(), "上游应已收到请求");
  controller.abort();
  await request;
  while (!upstreamClosed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(upstreamClosed(), true);
});

test("上游错误、网络错误、超时和异常响应被归一化", async (t) => {
  const { setup, origin, upstreamUrl, mode, last } = await fixture(t);
  await setup.completeInitialization({});
  assert.equal((await post(origin, "/api/v1/model/config", options(upstreamUrl))).status, 200);
  assert.equal((await post(origin, "/api/v1/model/test", {})).status, 200);
  assert.equal(last().authorization, undefined);
  for (const [upstream, expected] of [["401", "AUTH_FAILED"], ["403", "AUTH_FAILED"], ["404", "MODEL_NOT_FOUND"], ["429", "RATE_LIMITED"], ["500", "UPSTREAM_ERROR"], ["invalid", "INVALID_RESPONSE"], ["large", "INVALID_RESPONSE"], ["timeout", "TIMEOUT"]]) {
    mode(upstream);
    const response = await post(origin, "/api/v1/model/chat", { message: "Hello" });
    const body = await response.text();
    assert.equal(JSON.parse(body).error.category, expected);
    assert.doesNotMatch(body, /secret-error-from-upstream/);
  }
  const unreachable = createServer();
  unreachable.listen(0, "127.0.0.1");
  await once(unreachable, "listening");
  const port = unreachable.address().port;
  await new Promise((done) => unreachable.close(done));
  await post(origin, "/api/v1/model/config", options(`http://127.0.0.1:${port}/v1`));
  assert.equal((await (await post(origin, "/api/v1/model/test", {})).json()).error.category, "CONNECTION_REFUSED");
  assert.equal((await post(origin, "/api/v1/model/config", options("http://remote.example/v1"))).status, 400);
  assert.equal((await post(origin, "/api/v1/model/chat", { message: "" })).status, 400);
});

test("保留上游 HTTP 状态、代码、消息和请求 ID，并供前端展示", async (t) => {
  const { setup, origin, upstreamUrl, mode } = await fixture(t);
  await setup.completeInitialization({});
  await post(origin, "/api/v1/model/config", options(upstreamUrl));
  for (const status of [400, 401, 403, 404, 429, 500]) {
    mode(`structured-${status}`);
    const response = await post(origin, "/api/v1/model/test", {});
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error.source, "upstream");
    assert.equal(error.status, status);
    assert.equal(error.code, `upstream_${status}`);
    assert.equal(error.message, `上游故障 ${status}`);
    assert.equal(error.requestId, "req-safe-123");
    assert.equal(error.target, `${upstreamUrl}/chat/completions`);
    const display = formatModelError(error, response.status);
    assert.match(display, new RegExp(`HTTP ${status}`));
    assert.match(display, new RegExp(`upstream_${status}`));
    assert.match(display, new RegExp(`上游故障 ${status}`));
  }
  mode("plain");
  const plain = await (await post(origin, "/api/v1/model/test", {})).json();
  assert.equal(plain.error.status, 503);
  assert.equal(plain.error.message, "Service is temporarily unavailable.");
  mode("nonstandard");
  const nonstandard = await (await post(origin, "/api/v1/model/test", {})).json();
  assert.equal(nonstandard.error.code, "custom_error");
  assert.equal(nonstandard.error.type, "invalid_request");
  assert.equal(nonstandard.error.message, "Invalid model setting.");
  assert.match(formatModelError(nonstandard.error, 502), /类型：invalid_request/);
  assert.match(noModelResponseMessage(), /请求未获得 HTTP 响应/);
  assert.doesNotMatch(noModelResponseMessage(), /离线|Failed to fetch/);
  mode("empty");
  const empty = await (await post(origin, "/api/v1/model/test", {})).json();
  assert.equal(empty.error.category, "UPSTREAM_ERROR");
  assert.equal(empty.error.status, 500);
  assert.equal(empty.error.message, undefined);
});

test("上游文本、请求 ID 和日志不会泄漏密钥、认证头或对话正文", async (t) => {
  const { setup, origin, upstreamUrl, mode } = await fixture(t);
  const logs = [];
  t.mock.method(console, "warn", (...parts) => { logs.push(parts.join(" ")); });
  await setup.completeInitialization({});
  await post(origin, "/api/v1/model/config", options(upstreamUrl, { keyAction: "set", apiKey: "private-key" }));
  mode("unsafe");
  let response = await post(origin, "/api/v1/model/chat", { message: "sensitive-prompt" });
  let body = await response.text();
  assert.doesNotMatch(body, /private-key|Authorization|Cookie|session=hidden|sensitive-prompt/i);
  assert.equal(JSON.parse(body).error.status, 401);
  mode("echo-prompt");
  response = await post(origin, "/api/v1/model/chat", { message: "conversation-data" });
  body = await response.text();
  assert.doesNotMatch(body, /conversation-data|private-key/);
  assert.match(body, /REDACTED/);
  mode("partial-prompt");
  response = await post(origin, "/api/v1/model/chat", { message: "conversation-data" });
  body = await response.text();
  assert.doesNotMatch(body, /conversation/);
  assert.doesNotMatch(logs.join(" "), /private-key|sensitive-prompt|conversation-data|Authorization|Cookie/i);
  const target = safeTarget("https://user:private-key@example.com/v1/chat?api_key=private-key&token=hidden#fragment", ["private-key"], "conversation-data");
  assert.equal(target, "https://example.com/v1/chat");
});

test("按实际底层错误区分 DNS、连接、TLS、超时和未知故障", async (t) => {
  const { store, secrets, upstreamUrl, model } = await fixture(t);
  model.saveConfig(options(upstreamUrl));
  const logs = [];
  t.mock.method(console, "warn", (...parts) => { logs.push(parts.join(" ")); });
  for (const [cause, category] of [["ENOTFOUND", "DNS_ERROR"], ["EAI_AGAIN", "DNS_ERROR"], ["ECONNREFUSED", "CONNECTION_REFUSED"], ["EHOSTUNREACH", "CONNECTION_FAILED"], ["ECONNRESET", "CONNECTION_INTERRUPTED"], ["CERT_HAS_EXPIRED", "TLS_ERROR"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS_ERROR"], ["ETIMEDOUT", "TIMEOUT"], ["UNRECOGNIZED_SECRET", "NETWORK_ERROR"]]) {
    const failingFetch = async () => { throw new TypeError("do not expose network details", { cause: Object.assign(new Error("private-network-detail"), { code: cause }) }); };
    const service = new ModelService(store, secrets, failingFetch);
    await assert.rejects(service.chat("conversation-data"), (error) => {
      assert.equal(error.diagnostic.category, category);
      assert.equal(error.diagnostic.source, "stardust");
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /private-network-detail|conversation-data|UNRECOGNIZED_SECRET/);
      return true;
    });
  }
  assert.doesNotMatch(logs.join(" "), /private-network-detail|conversation-data|UNRECOGNIZED_SECRET/);
  assert.match(formatModelError({ source: "stardust", category: "DNS_ERROR", code: "ENOTFOUND" }, 502), /地址解析失败/);
});
