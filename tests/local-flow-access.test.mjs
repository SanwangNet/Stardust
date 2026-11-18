import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createVite } from "vite";
import { isTrustedLocalAccess, isTrustedDevProxyClient } from "../apps/server/dist/local-access.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { FlowPublication } from "../apps/server/dist/flow-publication.js";

const request = (changes = {}) => ({ socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 8347, ...changes.socket }, headers: { host: "127.0.0.1:8347", origin: "http://127.0.0.1:8347", ...changes.headers } });
const listener = { address: "127.0.0.1", family: "IPv4", port: 8347 };

test("local access checks the actual peer, bound listener, authority, origin and every proxy hop", () => {
  const allowed = req => isTrustedLocalAccess(req, listener, true);
  assert.equal(allowed(request()), true);
  assert.equal(allowed(request({ socket: { remoteAddress: "203.0.113.10" } })), false);
  assert.equal(allowed(request({ socket: { localAddress: "192.0.2.10" } })), false);
  assert.equal(isTrustedLocalAccess(request(), { ...listener, address: "0.0.0.0" }, true), false);
  assert.equal(isTrustedLocalAccess(request(), { ...listener, address: "::" }, true), false);
  assert.equal(allowed(request({ headers: { host: "evil.example:8347", origin: "http://evil.example:8347" } })), false);
  assert.equal(allowed(request({ headers: { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" } })), false);
  assert.equal(allowed(request({ headers: { origin: "https://attacker.example" } })), false);
  assert.equal(allowed(request({ headers: { origin: "null" } })), false);
  assert.equal(allowed(request({ headers: { origin: undefined } })), false);
  assert.equal(allowed(request({ headers: { "sec-fetch-site": "cross-site" } })), false);
  for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via"]) assert.equal(allowed(request({ headers: { [name]: "127.0.0.1" } })), false, name);
  assert.equal(allowed(request({ headers: { "x-stardust-dev-proxy": "forged" } })), false);
  const proof = randomBytes(32).toString("base64url"), proxied = request({ headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "x-stardust-dev-proxy": proof } });
  assert.equal(isTrustedLocalAccess(proxied, listener, true, proof), true);
  assert.equal(isTrustedLocalAccess(proxied, listener, true, randomBytes(32).toString("base64url")), false);
  assert.equal(isTrustedLocalAccess({ ...proxied, socket: { ...proxied.socket, localPort: 9999 } }, listener, true, proof), false);
  const viteRequest = request({ socket: { localPort: 5173 }, headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" } });
  assert.equal(isTrustedDevProxyClient(viteRequest), true);
  assert.equal(isTrustedDevProxyClient({ ...viteRequest, headers: { ...viteRequest.headers, "x-forwarded-for": "203.0.113.1" } }), false);
});

function testServer(root) {
  return createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] }, modelService: { chatContext: async () => "mock" }, flowPublication: new FlowPublication(join(root, "flow.json")) });
}
const closeServer = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test("loopback edits work without token or editor flag and hostile origins cannot write", async t => {
  const root = mkdtempSync(join(tmpdir(), "stardust-local-flow-")), oldToken = process.env.STARDUST_ADMIN_TOKEN, oldFlag = process.env.STARDUST_FLOW_EDITOR;
  delete process.env.STARDUST_ADMIN_TOKEN; delete process.env.STARDUST_FLOW_EDITOR;
  const server = testServer(root); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await closeServer(server); if (oldToken === undefined) delete process.env.STARDUST_ADMIN_TOKEN; else process.env.STARDUST_ADMIN_TOKEN = oldToken; if (oldFlag === undefined) delete process.env.STARDUST_FLOW_EDITOR; else process.env.STARDUST_FLOW_EDITOR = oldFlag; rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, get = path => fetch(origin + path), post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
  const overview = await (await get("/api/v1/flow-overview")).json(); assert.equal(overview.canEdit, true); assert.equal(overview.overview.publishedInUse, false);
  let state = await (await get("/api/v1/flow-publication")).json(); const firstRevision = state.revision;
  assert.equal((await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: false, global: false, search: false } }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: false, global: false, search: false } }, { host: `rebinding.example:${server.address().port}`, origin: `http://rebinding.example:${server.address().port}` })).status, 403);
  assert.equal((await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: false, global: false, search: false } }, { "x-forwarded-for": "127.0.0.1" })).status, 403);
  assert.equal((await fetch(origin + "/api/v1/flow-publication/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: state.revision, connections: state.draft }) })).status, 403);
  state = await (await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: false, global: false, search: false } })).json();
  assert.equal((await post("/api/v1/flow-publication/save", { revision: firstRevision, connections: state.draft })).status, 409);
  assert.equal((await post("/api/v1/flow-publication/validate", { revision: state.revision })).status, 200);
  assert.equal((await post("/api/v1/flow-publication/publish", { revision: state.revision })).status, 200);
  assert.deepEqual(new FlowPublication(join(root, "flow.json")).read().published.connections, { recent: false, global: false, search: false });
  assert.equal((await post("/api/v1/admin/login", {})).status, 405);
});

test("wildcard listener and apparent forwarded traffic remain read-only", async t => {
  const root = mkdtempSync(join(tmpdir(), "stardust-wildcard-flow-")), server = testServer(root); server.listen(0, "0.0.0.0"); await once(server, "listening");
  t.after(async () => { await closeServer(server); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + "/api/v1/flow-overview"); assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.canEdit, false);
  const post = (path, body) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/v1/flow-publication/save", { revision: "initial", connections: data.published.connections })).status, 403);
  assert.equal((await post("/api/v1/tool-runs", { message: "test" })).status, 403);
  assert.equal((await post("/api/v1/extensions/demo/enable", {})).status, 403);
});

test("actual loopback Vite proxy uses an ephemeral transport proof and refuses forged forwarding", async t => {
  const names = ["STARDUST_HOST", "STARDUST_PORT", "STARDUST_DEV_PROXY_PROOF"], old = names.map(name => process.env[name]);
  process.env.STARDUST_DEV_PROXY_PROOF = randomBytes(32).toString("base64url");
  const root = mkdtempSync(join(tmpdir(), "stardust-vite-flow-")), server = testServer(root); server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.STARDUST_HOST = "127.0.0.1"; process.env.STARDUST_PORT = String(server.address().port);
  const vite = await createVite({ configFile: resolve("vite.config.mjs"), server: { port: 0, strictPort: true }, logLevel: "silent", clearScreen: false }); await vite.listen();
  t.after(async () => { await vite.close(); await closeServer(server); names.forEach((name, i) => old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const get = await fetch(origin + "/api/v1/flow-overview"), overview = await get.json(); assert.equal(get.status, 200); assert.equal(overview.canEdit, true);
  const body = { revision: overview.revision, connections: { recent: false, global: true, search: true } };
  const post = (headers = {}) => fetch(origin + "/api/v1/flow-publication/save", { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ origin: "https://attacker.example" })).status, 403);
  assert.equal((await post({ "x-forwarded-for": "203.0.113.10" })).status, 403);
  assert.equal((await post({ "x-stardust-dev-proxy": "attacker-controlled" })).status, 200);
});
