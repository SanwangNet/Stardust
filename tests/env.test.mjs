import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, cp, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createEnvLoader, projectConfigRoot } from "../apps/server/dist/env.js";
import { resolveListenConfig } from "../apps/server/dist/config.js";

let root;
let loader;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "stardust-env-"));
  loader = createEnvLoader(root);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test("Core 配置从明确的根目录读取，默认值与进程变量优先级正确", async () => {
  assert.equal(resolve(projectConfigRoot), resolve(fileURLToPath(new URL("..", import.meta.url))));
  assert.deepEqual(loader.loadCoreEnv(), {});
  assert.deepEqual(resolveListenConfig(loader.loadCoreEnv(), {}), { host: "127.0.0.1", port: 8347 });
  await writeFile(join(root, ".env"), 'STARDUST_HOST=127.0.0.2\nSTARDUST_PORT=9351\nCORE_VALUE="hello world"\n');
  const core = loader.loadCoreEnv();
  assert.equal(core.CORE_VALUE, "hello world");
  assert.deepEqual(resolveListenConfig(core, {}), { host: "127.0.0.2", port: 9351 });
  assert.deepEqual(resolveListenConfig(core, { STARDUST_PORT: "9352" }), { host: "127.0.0.2", port: 9352 });
  assert.throws(() => resolveListenConfig({ STARDUST_PORT: "secret-value" }, {}), (error) => !error.message.includes("secret-value"));
});

test("扩展配置隔离，不修改进程环境；缺失返回未配置", async () => {
  for (const [id, value] of [["alpha", "first"], ["beta", "second"]]) {
    await mkdir(join(root, "env", id), { recursive: true });
    await writeFile(join(root, "env", id, ".env"), `SHARED_NAME=${value}\n`);
  }
  const previous = process.env.SHARED_NAME;
  assert.deepEqual(loader.loadExtensionEnv("alpha"), { configured: true, values: { SHARED_NAME: "first" } });
  assert.deepEqual(loader.loadExtensionEnv("beta"), { configured: true, values: { SHARED_NAME: "second" } });
  assert.equal(process.env.SHARED_NAME, previous);
  assert.deepEqual(loader.loadExtensionEnv("missing"), { configured: false });
  await mkdir(join(root, "env", "empty"));
  assert.deepEqual(loader.loadExtensionEnv("empty"), { configured: false });
});

test("拒绝非法 ID 和指向配置目录外的符号链接", async (t) => {
  for (const id of ["", "../alpha", "alpha/../beta", "alpha\\beta", ".", "..", "Alpha", "alpha--beta", "con", "x".repeat(65)]) {
    assert.throws(() => loader.loadExtensionEnv(id), /无效的扩展 ID/);
  }
  try {
    await symlink(root, join(root, "env", "linked"), "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.diagnostic("当前环境不允许创建符号链接");
    throw error;
  }
  assert.throws(() => loader.loadExtensionEnv("linked"), /无法读取扩展环境配置/);
});

test("从其他工作目录启动时使用项目根 .env，缺失扩展配置不影响运行且不泄露密钥", async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
  const project = join(root, "project");
  await mkdir(join(project, "apps", "server"), { recursive: true });
  await cp(resolve("apps/server/dist"), join(project, "apps", "server", "dist"), { recursive: true });
  await writeFile(join(project, "package.json"), '{"type":"module"}');
  await writeFile(join(project, ".env"), `STARDUST_HOST=127.0.0.1\nSTARDUST_PORT=${port}\nCORE_SECRET=do-not-log-this-secret\n`);
  assert.deepEqual(createEnvLoader(project).loadExtensionEnv("missing"), { configured: false });
  const env = { ...process.env };
  delete env.STARDUST_HOST;
  delete env.STARDUST_PORT;
  const child = spawn(process.execPath, [join(project, "apps", "server", "dist", "main.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("服务启动超时")), 5000);
      child.stdout.on("data", () => { if (output.includes("已启动")) { clearTimeout(timer); resolveReady(); } });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("服务提前退出")); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /do-not-log-this-secret/);
    assert.doesNotMatch(output, /do-not-log-this-secret/);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});


