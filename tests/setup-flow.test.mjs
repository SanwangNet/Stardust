import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createConfigStore } from "../apps/server/dist/config.js";
import { SetupService } from "../apps/server/dist/setup.js";
import { runSetupWizard } from "../apps/server/dist/setup-cli.js";
import { createStardustServer } from "../apps/server/dist/app.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "stardust-flow-"));
  const setup = new SetupService(createConfigStore(root));
  const server = createStardustServer({ setupService: setup });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, setup, origin };
}
function post(origin, body, headers = {}) {
  return fetch(`${origin}/api/v1/setup/complete`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function cliDriver(setup) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const done = runSetupWizard(setup, input, output);
  async function waitFor(value) {
    const end = Date.now() + 4000;
    while (!text.includes(value)) {
      if (Date.now() > end) throw new Error(`没有显示提示：${value}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function send(value, next) { input.write(`${value}\n`); if (next) await waitFor(next); }
  return { done, send, waitFor, text: () => text };
}

test("HTTP 初始化校验、来源检查、上限和持久化", async (t) => {
  const { root, origin } = await fixture(t);
  let response = await fetch(`${origin}/api/v1/setup/state`);
  const state = await response.json();
  assert.equal(state.initialized, false);
  assert.deepEqual(state.config.service, { description: "" });
  for (const invalid of [{ server: { port: 0 } }, { service: { name: " " } }, { initialized: true }, null]) {
    response = await post(origin, invalid);
    assert.equal(response.status, 400);
  }
  assert.equal((await post(origin, "not json")).status, 400);
  assert.equal((await post(origin, {}, { Origin: "https://other.example" })).status, 403);
  assert.equal((await post(origin, {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post(origin, JSON.stringify({ service: { description: "x".repeat(17000) } }))).status, 413);
  response = await post(origin, { service: { description: "Web" }, web: { title: "测试标题" } }, { Origin: origin });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { initialized: true });
  response = await post(origin, {});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "ALREADY_INITIALIZED");
  assert.deepEqual(await (await fetch(`${origin}/api/v1/setup/state`)).json(), { initialized: true, webTitle: "测试标题" });
  assert.equal(new SetupService(createConfigStore(root)).getInitializationState().initialized, true);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test("保存失败返回 500，允许相同请求重试", async (t) => {
  const { origin, setup } = await fixture(t);
  const mocked = t.mock.method(fs, "renameSync", () => { throw new Error("internal-secret"); });
  const response = await post(origin, {});
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /internal-secret/);
  assert.equal(setup.getInitializationState().initialized, false);
  mocked.mock.restore();
  assert.equal((await post(origin, {})).status, 200);
});

test("终端向导可使用默认值完成且不关闭服务", async (t) => {
  const { setup, origin } = await fixture(t);
  const cli = await cliDriver(setup);
  await cli.send("", "服务描述");
  await cli.send("CLI", "WebUI 标题");
  await cli.send("", "修改监听地址");
  await cli.send("", "确认完成初始化");
  await cli.send("");
  await cli.done;
  assert.match(cli.text(), /初始化完成/);
  assert.doesNotMatch(cli.text(), /服务名称/);
  assert.equal(setup.getSetupConfig().service.description, "CLI");
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal((await post(origin, {})).status, 409);
});

test("终端输入非法时可重试，取消不会初始化", async (t) => {
  const { setup } = await fixture(t);
  const cli = await cliDriver(setup);
  await cli.send("", "服务描述");
  await cli.send("", "WebUI 标题");
  await cli.send(" ", "web.title 必须是非空字符串");
  await cli.send("CLI", "修改监听地址");
  await cli.send("y", "监听地址 [");
  await cli.send("", "端口 [");
  await cli.send("0", "server.port 必须是 1–65535 之间的整数");
  await cli.send(":q");
  await cli.done;
  assert.match(cli.text(), /已取消初始化/);
  assert.equal(setup.getInitializationState().initialized, false);
});

test("Web 先完成时终端向导自动退出，无法覆盖", async (t) => {
  const { setup, origin } = await fixture(t);
  const cli = await cliDriver(setup);
  await cli.send("", "服务描述");
  assert.equal((await post(origin, { service: { description: "Web" } })).status, 200);
  await cli.done;
  assert.match(cli.text(), /初始化已由其他入口完成/);
  assert.equal(setup.getSetupConfig().service.description, "Web");
});

test("CLI 与 HTTP 同时提交时只有一个入口成功", async (t) => {
  const { setup, origin } = await fixture(t);
  const cli = await cliDriver(setup);
  await cli.send("", "服务描述");
  await cli.send("CLI", "WebUI 标题");
  await cli.send("", "修改监听地址");
  await cli.send("", "确认完成初始化");
  const [response] = await Promise.all([post(origin, { service: { description: "Web" } }), cli.send("")]);
  await cli.done;
  assert.ok(response.status === 200 || response.status === 409);
  assert.equal(setup.getSetupConfig().service.description, response.status === 200 ? "Web" : "CLI");
  assert.match(cli.text(), response.status === 200 ? /初始化已由其他入口完成/ : /初始化完成/);
});
