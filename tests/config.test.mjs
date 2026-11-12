import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, cp, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { createConfigStore, resolveConfig } from "../apps/server/dist/config.js";

let root;
let store;
const expectedDefaults = {
  initialized: false,
  service: { name: "Stardust", description: "" },
  server: { host: "127.0.0.1", port: 8347 },
  web: { title: "Stardust" },
};
before(async () => {
  root = await mkdtemp(join(tmpdir(), "stardust-config-"));
  store = createConfigStore(root);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test("文件缺失时返回默认值而不创建文件，部分字段使用默认值", async () => {
  assert.deepEqual(store.loadConfig(), expectedDefaults);
  await assert.rejects(access(join(root, "config.toml")), { code: "ENOENT" });
  await writeFile(join(root, "config.toml"), '[service]\nname = "Example"\n[server]\nport = 9001\n');
  assert.deepEqual(store.loadConfig(), {
    ...expectedDefaults, service: { name: "Example", description: "" }, server: { host: "127.0.0.1", port: 9001 },
  });
});

test("TOML 和两层环境变量按优先级合并，不修改 process.env", async () => {
  await writeFile(join(root, "config.toml"), '[server]\nhost = "localhost"\nport = 9001\n[web]\ntitle = "Test"\n');
  const config = store.loadConfig();
  const previous = process.env.STARDUST_PORT;
  assert.deepEqual(resolveConfig(config, {}, {}).server, { host: "localhost", port: 9001 });
  assert.deepEqual(resolveConfig(config, { STARDUST_HOST: "127.0.0.2", STARDUST_PORT: "9002" }, {}).server, { host: "127.0.0.2", port: 9002 });
  assert.deepEqual(resolveConfig(config, { STARDUST_HOST: "127.0.0.2", STARDUST_PORT: "9002" }, { STARDUST_HOST: "127.0.0.3", STARDUST_PORT: "9003" }).server, { host: "127.0.0.3", port: 9003 });
  assert.equal(resolveConfig(config, {}, {}).web.title, "Test");
  assert.equal(process.env.STARDUST_PORT, previous);
});

test("非法格式、类型、端口和未知字段明确报错且不覆盖原文件", async () => {
  for (const [source, pattern] of [
    ['[server\nport = 1', /config.toml 格式错误/],
    ['[server]\nport = "8347"', /server.port/],
    ['[server]\nport = 0', /server.port/],
    ['[server]\nport = 65536', /server.port/],
    ['[server]\nport = 3.5', /server.port/],
    ['[server]\nhost = 12', /server.host/],
    ['[service]\nname = ""', /service.name/],
    ['[web]\ntitle = true', /web.title/],
    ['[server]\ntoken = "sensitive"', /未知配置字段/],
    ['[other]\nname = "x"', /未知配置字段/],
  ]) {
    await writeFile(join(root, "config.toml"), source);
    assert.throws(() => store.loadConfig(), pattern);
    assert.throws(() => store.saveConfig(expectedDefaults), pattern);
    assert.equal(await readFile(join(root, "config.toml"), "utf8"), source);
  }
});

test("保存并重新读取配置，拒绝未知和敏感字段", async () => {
  await rm(join(root, "config.toml"));
  const value = {
    service: { name: 'Star "dust"', description: "第一行\n第二行" },
    server: { host: "localhost", port: 9005 },
    web: { title: "星尘" },
  };
  store.saveConfig(value);
  assert.deepEqual(store.loadConfig(), { initialized: false, ...value });
  const original = await readFile(join(root, "config.toml"), "utf8");
  assert.throws(() => store.saveConfig({ ...value, apiKey: "do-not-store" }), /未知配置字段/);
  assert.throws(() => store.saveConfig({ ...value, service: { ...value.service, secret: "do-not-store" } }), /未知配置字段/);
  assert.throws(() => store.saveConfig({ ...value, server: { ...value.server, port: -1 } }), /server.port/);
  assert.equal(await readFile(join(root, "config.toml"), "utf8"), original);
  assert.doesNotMatch(original, /do-not-store/);
});

test("替换失败时保留原文件并清理临时文件", async (t) => {
  const path = join(root, "config.toml");
  const original = await readFile(path, "utf8");
  t.mock.method(fs, "renameSync", () => { throw new Error("simulated failure"); });
  assert.throws(() => store.saveConfig(expectedDefaults), /无法保存 config.toml/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".config.toml.")), []);
});

test("从其他工作目录启动时读取项目根 TOML，无配置文件也能启动", async () => {
  const project = join(root, "project");
  await mkdir(join(project, "apps", "server"), { recursive: true });
  await cp(resolve("apps/server/dist"), join(project, "apps", "server", "dist"), { recursive: true });
  await mkdir(join(project, "node_modules", "@iarna"), { recursive: true });
  await cp(resolve("node_modules/@iarna/toml"), join(project, "node_modules", "@iarna", "toml"), { recursive: true });
  await writeFile(join(project, "package.json"), '{"type":"module"}');

  async function availablePort() {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
    return port;
  }
  async function startAndCheck(port, env) {
    const child = spawn(process.execPath, [join(project, "apps", "server", "dist", "main.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((ready, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("服务启动超时")), 5000);
        child.stdout.on("data", (data) => { output += data; if (output.includes("已启动")) { clearTimeout(timer); ready(); } });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("服务提前退出")); });
      });
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    } finally {
      child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }
  }
  const env = { ...process.env };
  delete env.STARDUST_HOST;
  delete env.STARDUST_PORT;
  const firstPort = await availablePort();
  await startAndCheck(firstPort, { ...env, STARDUST_PORT: String(firstPort) });
  await assert.rejects(access(join(project, "config.toml")), { code: "ENOENT" });
  const secondPort = await availablePort();
  await writeFile(join(project, "config.toml"), `[server]\nhost = "127.0.0.1"\nport = ${secondPort}\n`);
  await startAndCheck(secondPort, env);
});
