import assert from "node:assert/strict";
import fs from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfigStore } from "../apps/server/dist/config.js";
import { SetupService } from "../apps/server/dist/setup.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "stardust-setup-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = createConfigStore(root);
  return { root, store, setup: new SetupService(store) };
}

test("缺少配置或标记时未初始化，读取不会创建文件", async (t) => {
  const { root, setup } = await fixture(t);
  assert.deepEqual(setup.getInitializationState(), { initialized: false });
  await assert.rejects(access(join(root, "config.toml")), { code: "ENOENT" });
  await writeFile(join(root, "config.toml"), '[service]\nname = "Existing"\n');
  assert.deepEqual(setup.getInitializationState(), { initialized: false });
  await writeFile(join(root, "config.toml"), 'initialized = "false"\n');
  assert.throws(() => setup.getInitializationState(), /initialized 必须是布尔值/);
});

test("初始化合并已有配置，持久化后重新读取，并拒绝第二次提交", async (t) => {
  const { root, store, setup } = await fixture(t);
  await writeFile(join(root, "config.toml"), '[service]\nname = "Existing"\ndescription = "Keep"\n[server]\nport = 9001\n[web]\ntitle = "Original"\n');
  const result = await setup.completeInitialization({ service: { name: "New" }, web: { title: "Updated" } });
  assert.deepEqual(result, {
    initialized: true,
    service: { name: "New", description: "Keep" },
    server: { host: "127.0.0.1", port: 9001 },
    web: { title: "Updated" },
  });
  assert.deepEqual(new SetupService(createConfigStore(root)).getInitializationState(), { initialized: true });
  assert.deepEqual(store.loadConfig(), result);
  const original = await readFile(join(root, "config.toml"), "utf8");
  await assert.rejects(setup.completeInitialization({ server: { port: 9100 } }), { code: "ALREADY_INITIALIZED" });
  assert.equal(await readFile(join(root, "config.toml"), "utf8"), original);
});

test("同一进程中不同服务实例并发提交只成功一次", async (t) => {
  const { root, store, setup } = await fixture(t);
  const second = new SetupService(createConfigStore(root));
  const results = await Promise.allSettled([
    setup.completeInitialization({ service: { name: "First" } }),
    second.completeInitialization({ service: { name: "Second" } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "ALREADY_INITIALIZED");
  const winner = results.find((result) => result.status === "fulfilled");
  assert.deepEqual(store.loadConfig(), winner.value);
  assert.equal(store.loadConfig().initialized, true);
});

test("保存失败不标记初始化，解除故障后可重试", async (t) => {
  const { root, store, setup } = await fixture(t);
  const original = '[service]\nname = "Existing"\n';
  await writeFile(join(root, "config.toml"), original);
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("simulated failure"); });
  await assert.rejects(setup.completeInitialization({ service: { name: "New" } }), /无法保存 config.toml/);
  assert.deepEqual(setup.getInitializationState(), { initialized: false });
  assert.equal(await readFile(join(root, "config.toml"), "utf8"), original);
  rename.mock.restore();
  await setup.completeInitialization({});
  assert.equal(store.loadConfig().initialized, true);
});

test("初始化输入校验失败及普通保存均不能修改初始化标记", async (t) => {
  const { root, store, setup } = await fixture(t);
  await assert.rejects(setup.completeInitialization({ initialized: true }), /未知配置字段/);
  await assert.rejects(setup.completeInitialization({ server: { port: 0 } }), /server.port/);
  assert.deepEqual(setup.getInitializationState(), { initialized: false });
  await assert.rejects(access(join(root, "config.toml")), { code: "ENOENT" });
  const before = store.loadConfig();
  assert.throws(() => store.saveConfig({ ...before, initialized: true }), /不能修改 initialized/);
  await setup.completeInitialization({});
  const current = store.loadConfig();
  const { initialized: _initialized, ...settings } = current;
  store.saveConfig({ ...settings, web: { title: "Changed" } });
  assert.equal(store.loadConfig().initialized, true);
  assert.equal(store.loadConfig().web.title, "Changed");
  assert.throws(() => store.saveConfig({ ...current, initialized: false }), /不能修改 initialized/);
  assert.equal(store.loadConfig().initialized, true);
});
