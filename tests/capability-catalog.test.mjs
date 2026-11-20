import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { LogService } from "../apps/server/dist/logger.js";
import { ToolRuns } from "../apps/server/dist/tool-runs.js";
import { skillContractHash, builtInSkillFlow, runSkillFlow } from "../apps/server/dist/skill-flow.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const skill = (owner, name, content, extra = {}) => ({ id: `${owner}:${name}`, owner, name, description: `Skill ${name}`, version: "1", contentHash: hash(content), channels: ["web"], keywords: ["task"], defaultEnabled: true, requiredCapabilities: [], ...extra });
const binding = (declaration, content) => ({ id: declaration.id, owner: declaration.owner, contentHash: declaration.contentHash, contractHash: skillContractHash(declaration), load: () => content });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "stardust-capabilities-")), hosts = new Map(), counts = { execute: 0, load: 0 };
  const a = skill("alpha", "one", "PRIVATE_SKILL_BODY"), b = skill("beta", "two", "OTHER_BODY"), untrusted = skill("beta", "untrusted", "UNTRUSTED_BODY");
  const mkTool = name => ({ name, description: `Tool ${name}`, parameters: { type: "object" }, validate: input => input, prepare: () => ({ approval: { operation: "test", targetDescription: "test", risk: "test" } }), async execute() { counts.execute++; return { status: "sent" }; } });
  const pkg = (id, skills) => ({ manifest: { id, name: id, version: "1", description: "fixture", type: "channel", fields: [{ key: "secret", env: "SECRET", label: "Secret", sensitive: true, required: false }], skills }, tools: [mkTool(`${id}_tool`)], create(_config, host) { hosts.set(id, host); return { start() { host.status("connected"); }, stop() {} }; } });
  const packages = [pkg("alpha", [a]), pkg("beta", [b, untrusted])];
  const firstBinding = binding(a, "PRIVATE_SKILL_BODY"), secondBinding = binding(b, "OTHER_BODY");
  firstBinding.load = () => { counts.load++; return "PRIVATE_SKILL_BODY"; };
  const manager = new ExtensionManager(root, { chat: async () => "unused" }, packages, new LogService(100, () => {}), [firstBinding, secondBinding]);
  t.after(async () => { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const setup = async () => { for (const id of ["alpha", "beta"]) { await manager.install(id); await manager.saveConfig(id, { secret: "SECRET_TOKEN_123" }); await manager.enable(id); await manager.setToolEnabled(id, `${id}_tool`, true); } };
  return { manager, hosts, packages, counts, setup };
}
const webPolicy = { channel: "web", allowTool: name => name === "alpha_tool", allowSkill: id => id === "beta:two" };

test("catalog combines providers, declarations and current lifecycle without exposing execution data", async t => {
  const f = fixture(t), before = f.manager.capabilityCatalog();
  assert.equal(before.providers.length, 2); assert.equal(before.capabilities.length, 5);
  assert.ok(before.capabilities.every(item => !item.available && item.unavailableReason === "uninstalled"));
  await f.setup();
  const catalog = f.manager.capabilityCatalog(), byId = id => catalog.capabilities.find(item => item.id === id);
  assert.equal(new Set(catalog.capabilities.map(item => item.id)).size, 5);
  assert.deepEqual(catalog.providers.map(item => [item.id, item.installed, item.enabled, item.state]), [["alpha", true, true, "connected"], ["beta", true, true, "connected"]]);
  assert.equal(byId("tool:alpha:alpha_tool").providerId, "alpha"); assert.equal(byId("tool:beta:beta_tool").available, true);
  assert.equal(byId("skill:alpha:one").available, true); assert.equal(byId("skill:beta:two").providerId, "beta");
  assert.equal(byId("skill:beta:untrusted").unavailableReason, "untrusted");
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET_TOKEN_123|PRIVATE_SKILL_BODY|UNTRUSTED_BODY|parameters|target|contentHash/);
  assert.deepEqual(f.counts, { execute: 0, load: 0 });
  await f.manager.setToolEnabled("alpha", "alpha_tool", false);
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "tool:alpha:alpha_tool").unavailableReason, "disabled");
  await f.manager.setSkillEnabled("beta", "beta:two", false);
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "skill:beta:two").unavailableReason, "disabled");
  await f.manager.disable("alpha");
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "skill:alpha:one").unavailableReason, "extension_disabled");
  await f.manager.uninstall("beta", false);
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "skill:beta:two").unavailableReason, "uninstalled");
});

test("trusted policy limits visibility and stale snapshots cannot bypass current state", async t => {
  const f = fixture(t); await f.setup();
  const request = f.manager.requestCapabilities(webPolicy);
  assert.deepEqual(request.visible.map(item => item.id).sort(), ["skill:beta:two", "tool:alpha:alpha_tool"]);
  assert.equal(request.isEligible("tool:alpha:alpha_tool"), true);
  const qq = f.manager.requestCapabilities({ channel: "qq", allowTool: () => false, allowSkill: () => false, source: { starcoreId: "web-chat" } });
  assert.deepEqual(qq.visible, []); assert.equal(qq.isEligible("tool:alpha:alpha_tool"), false);
  await f.manager.setToolEnabled("alpha", "alpha_tool", false);
  assert.equal(request.isEligible("tool:alpha:alpha_tool"), false);
  assert.equal((await f.manager.executeTool("alpha_tool", {}, new AbortController().signal)).status, "unavailable");
  await f.manager.setSkillEnabled("beta", "beta:two", false); assert.equal(request.isEligible("skill:beta:two"), false);
  assert.deepEqual(f.counts, { execute: 0, load: 0 });
});

test("disconnect revokes existing tool and skill leases; reconnect gives new snapshots", async t => {
  const f = fixture(t); await f.setup();
  const lease = f.manager.toolSignal("alpha_tool"), channelLease = f.manager.channelSignal("alpha"), skills = f.manager.skillSnapshot(), oldSkill = skills.find(item => item.declaration.id === "alpha:one");
  f.hosts.get("alpha").status("disconnected");
  assert.equal(lease.aborted, true); assert.equal(channelLease.aborted, true); assert.equal(oldSkill.signal.aborted, true); assert.equal(oldSkill.isAvailable(), false);
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "tool:alpha:alpha_tool").available, false);
  assert.equal(f.manager.toolSignal("alpha_tool"), undefined);
  f.hosts.get("alpha").status("connected");
  assert.equal(f.manager.capabilityCatalog().capabilities.find(item => item.id === "tool:alpha:alpha_tool").available, true);
  assert.equal(f.manager.toolSignal("alpha_tool").aborted, false); assert.equal(f.manager.channelSignal("alpha").aborted, false); assert.equal(oldSkill.isAvailable(), false);
  assert.equal(f.manager.skillSnapshot().find(item => item.declaration.id === "alpha:one").isAvailable(), true);
});

test("a pending approval cannot survive a disconnect and reconnect", async t => {
  const f = fixture(t); await f.setup(); let turns = 0, result;
  const model = { async chatWithTools(messages) { turns++; if (turns === 1) return { content: "", toolCalls: [{ id: "one", name: "alpha_tool", arguments: "{}" }] }; result = JSON.parse(messages.at(-1).content); return { content: "done", toolCalls: [] }; } };
  const runs = new ToolRuns(model, f.manager, new LogService(100, () => {})); t.after(() => runs.shutdown());
  const id = runs.start("owner", "test");
  for (let i = 0; i < 100 && runs.get("owner", id).status !== "waiting"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runs.get("owner", id).status, "waiting");
  f.hosts.get("alpha").status("disconnected"); f.hosts.get("alpha").status("connected");
  assert.throws(() => runs.decide("owner", id, "one", true), /APPROVAL_UNAVAILABLE/);
  for (let i = 0; i < 100 && runs.get("owner", id).status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runs.get("owner", id).status, "done"); assert.equal(f.counts.execute, 0);
  assert.equal(result.code, "TOOL_DISABLED"); assert.equal(turns, 2);
});

test("duplicate tools are rejected and duplicate or incompatible skills are not loadable", async t => {
  const f = fixture(t); await f.setup();
  const duplicate = { ...f.packages[1], tools: [f.packages[0].tools[0]] };
  assert.throws(() => new ExtensionManager(tmpdir(), undefined, [f.packages[0], duplicate]), /DUPLICATE_TOOL/);
  const previous = f.manager.skillSnapshot().find(item => item.declaration.id === "alpha:one");
  f.packages[0].manifest.skills.push({ ...f.packages[0].manifest.skills[0] });
  assert.equal(previous.isAvailable(), false);
  assert.ok(f.manager.skillWarnings().includes("alpha:SKILL_CONTRACT_INVALID"));
  assert.ok(!f.manager.capabilityCatalog().capabilities.some(item => item.id === "skill:alpha:one"));
  f.packages[1].manifest.skills[0] = { ...f.packages[1].manifest.skills[0], keywords: ["modified"] };
  const item = f.manager.skillSnapshot().find(value => value.declaration.id === "beta:two");
  assert.equal(item.available, false); assert.equal(item.load, undefined); assert.equal(item.isAvailable(), false);
  const result = await runSkillFlow(builtInSkillFlow([item]), [item], "task", [{ role: "user", content: "task" }], 48000);
  assert.deepEqual(result.loaded, []); assert.equal(f.counts.load, 0);
});

test("local catalog endpoint exposes metadata only", async t => {
  const f = fixture(t); await f.setup();
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: f.manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/v1/capabilities`); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.capabilities.length, 5);
  assert.doesNotMatch(JSON.stringify(body), /SECRET_TOKEN_123|PRIVATE_SKILL_BODY/);
  assert.equal((await fetch(`${origin}/api/v1/capabilities`, { headers: { origin: "https://evil.example" } })).status, 403);
});
