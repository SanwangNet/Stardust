import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { createStardustServer } from "../apps/server/dist/app.js";

const server = createStardustServer({ version: "test-version" });
let origin;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("/api/health 返回真实的 TypeScript Server 状态", async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "Stardust");
  assert.equal(body.version, "test-version");
  assert.ok(body.uptimeMs >= 0);
  assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("不支持在健康检查接口上写入", async () => {
  const response = await fetch(`${origin}/api/health`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error, "METHOD_NOT_ALLOWED");
});

test("WebUI 首页与静态脚本由同一进程提供", async () => {
  const html = await fetch(origin);
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.match(page, /服务状态/);
  assert.doesNotMatch(page, /服务名称|setup-name/);
  const js = await fetch(`${origin}/main.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /api\/health/);
  const motion = await fetch(`${origin}/navigation-motion.js`);
  assert.equal(motion.status, 404);
  const css = await fetch(`${origin}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
});

test("未知资源 404，且不提供任意文件访问", async () => {
  const response = await fetch(`${origin}/not-here`);
  assert.equal(response.status, 404);
  const envProbe = await fetch(`${origin}/.env`);
  assert.equal(envProbe.status, 404);
});

