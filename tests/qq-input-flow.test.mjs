import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qqInputDeclaration, validateStarcoreFlow } from "../apps/server/dist/starcore-flow.js";
import { runQQInputFlow } from "../apps/server/dist/qq-input-flow.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";

const graph = () => qqInputDeclaration("1.0.0").groups[0].flow;
const request = (overrides = {}) => ({ eventId: "event", messageId: "message", conversationId: "qq-session", signal: new AbortController().signal, diagnostic() {}, filter() { return true; }, ...overrides });
const run = (flow, req = request(), signal = new AbortController().signal, timeout = 5000) => runQQInputFlow(flow, req, signal, timeout);

test("QQ nested group executes the required filter and maps its result", async () => {
  let diagnostic = 0, filter = 0;
  const req = request({ diagnostic() { diagnostic++; }, filter() { filter++; return true; } });
  assert.equal(await run(graph(), req), "allow");
  assert.deepEqual([diagnostic, filter], [1, 1]);
  assert.equal(await run(graph(), request({ filter: () => false })), "skip");
});

test("disconnected optional diagnostic is not called; required filter cannot be bypassed", async () => {
  const flow = graph(), child = flow.graphs[1]; let diagnostic = 0, filter = 0;
  const diagnosticEdge = child.edges.find(edge => edge.from.node === "diagnostic" && edge.to.node === "accept");
  child.edges = child.edges.filter(edge => edge !== diagnosticEdge);
  const req = request({ diagnostic() { diagnostic++; }, filter() { filter++; return true; } });
  assert.equal(await run(flow, req), "allow"); assert.deepEqual([diagnostic, filter], [0, 1]);
  child.edges.push(diagnosticEdge); assert.equal(await run(flow, req), "allow"); assert.deepEqual([diagnostic, filter], [1, 2]);
  child.edges = child.edges.filter(edge => edge.from.node !== "accept" || edge.to.node !== "output");
  await assert.rejects(run(flow, req), /QQ_FLOW_INVALID/); assert.equal(filter, 2);
  child.edges.push({ from: { node: "input", port: "value" }, to: { node: "output", port: "value" } });
  await assert.rejects(run(flow, req), /QQ_FLOW_FAILED/); assert.equal(filter, 2);
});

test("untrusted node types, ports, declarations and incompatible interfaces fail closed", async () => {
  const item = createQQBotExtension(), validate = flow => validateStarcoreFlow(item.manifest, flow, item.tools.map(t => t.name));
  const forged = structuredClone(item.flow); forged.nodes[0].id = "qq-bot:fake"; assert.throws(() => validate(forged), /FLOW_ADAPTER_UNTRUSTED/);
  const altered = structuredClone(item.flow); altered.nodes[0].inputs.value.type = "json"; assert.throws(() => validate(altered), /FLOW_ADAPTER_UNTRUSTED/);
  const fakePort = graph(); fakePort.graphs[1].edges[0].to.port = "fake"; await assert.rejects(run(fakePort), /QQ_FLOW_INVALID/);
  const fakeType = graph(); fakeType.graphs[1].nodes[1].type = "qq-bot:fake"; await assert.rejects(run(fakeType), /QQ_FLOW_INVALID/);
  const noBinding = structuredClone(item.flow); noBinding.nodes[0].executable = false; delete noBinding.nodes[0].adapter; assert.throws(() => validate(noBinding), /FLOW_ADAPTER_UNTRUSTED/);
});

test("abort and timeout reach adapters and prevent subsequent stages", async () => {
  const controller = new AbortController(); let filter = 0, received;
  const pending = run(graph(), request({ signal: controller.signal, diagnostic(signal) { received = signal; return new Promise(() => {}); }, filter() { filter++; return true; } }));
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /QQ_FLOW_CANCELLED/); assert.equal(received.aborted, true); assert.equal(filter, 0);
  let timeoutSignal;
  const timed = run(graph(), request({ diagnostic(signal) { timeoutSignal = signal; return new Promise(() => {}); }, filter() { filter++; return true; } }), new AbortController().signal, 20);
  await assert.rejects(timed, /QQ_FLOW_CANCELLED/); assert.equal(timeoutSignal.aborted, true); assert.equal(filter, 0);
  const lifecycle = new AbortController(); lifecycle.abort(); await assert.rejects(run(graph(), request(), lifecycle.signal), /QQ_FLOW_CANCELLED/);
});

function mockBot() {
  const handlers = new Map(); let finish;
  return { sent: [], on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); }, async sendText(target, content) { this.sent.push({ target, content }); return { id: `reply-${this.sent.length}` }; }, emit(message) { return handlers.get("message")({}, message); } };
}
const event = (kind, id, extra = {}) => ({ kind, rawEventType: kind === "c2c" ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", senderId: "sender", messageId: id, timestamp: new Date().toISOString(), content: " hello ", ...(kind === "group" ? { groupOpenid: "session" } : {}), replyTarget: { scope: kind, targetId: "session", msgId: id }, ...extra });
async function fixture(enabled) {
  process.env.STARDUST_QQ_INPUT_FLOW = enabled ? "1" : "0";
  const root = await mkdtemp(join(tmpdir(), "stardust-qq-flow-")), bot = mockBot(), item = createQQBotExtension(async () => bot);
  const create = item.create; let retainedAdapter;
  item.create = (config, host) => { retainedAdapter = host.qqInputFlow; return create(config, host); };
  const model = { calls: [], async chat(content) { this.calls.push(content); return "mock reply"; } };
  const manager = new ExtensionManager(root, model, [item]); const received = [];
  manager.setChannelChat(async (message, signal) => { received.push({ ...message, eventId: undefined, targetRef: undefined }); return model.chat(message.content, signal); });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  for (let i = 0; i < 50 && manager.list()[0].state !== "connected"; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.list()[0].state, "connected");
  return { root, manager, model, received, bot, item, retainedAdapter, async close() { await manager.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test("mock QQ gateway follows legacy and flow paths equivalently and obeys lifecycle", async () => {
  const old = process.env.STARDUST_QQ_INPUT_FLOW; let legacy, flow;
  try {
    legacy = await fixture(false);
    assert.equal(legacy.manager.flowCatalog()[0].requestChain, false);
    const sample = [event("c2c", "private"), event("c2c", "private"), event("group", "ignored", { rawEventType: "GROUP_MESSAGE_CREATE" }), event("group", "group"), event("c2c", "robot", { senderIsBot: true })];
    for (const msg of sample) await legacy.bot.emit(msg);
    assert.equal(legacy.model.calls.length, 2); assert.equal(legacy.bot.sent.length, 2);
    await legacy.manager.shutdown();
    flow = await fixture(true);
    assert.equal(flow.manager.flowCatalog()[0].requestChain, true);
    for (const msg of sample) await flow.bot.emit(msg);
    assert.deepEqual(flow.received, legacy.received); assert.deepEqual(flow.bot.sent, legacy.bot.sent);
    assert.equal(flow.model.calls.length, 2);
    const child = flow.item.flow.groups[0].flow.graphs[1], saved = child.edges;
    child.edges = saved.filter(edge => edge.to.node !== "output");
    await flow.bot.emit(event("c2c", "broken")); assert.equal(flow.model.calls.length, 2);
    child.edges = saved;
    await flow.manager.disable("qq-bot"); assert.equal(flow.manager.flowCatalog()[0].requestChain, false);
    await flow.bot.emit(event("c2c", "after-disable")); assert.equal(flow.model.calls.length, 2);
    await flow.manager.uninstall("qq-bot", false); await flow.bot.emit(event("c2c", "after-uninstall")); assert.equal(flow.model.calls.length, 2);
    let called = false; await assert.rejects(flow.retainedAdapter(request({ filter() { called = true; return true; } })), /QQ_FLOW_UNAVAILABLE/); assert.equal(called, false);
  } finally { await legacy?.close(); await flow?.close(); if (old === undefined) delete process.env.STARDUST_QQ_INPUT_FLOW; else process.env.STARDUST_QQ_INPUT_FLOW = old; }
});

test("the known C1 QQ fingerprint migrates on restore; incompatible contracts stay blocked", async () => {
  const old = process.env.STARDUST_QQ_INPUT_FLOW; let f, restored;
  try {
    f = await fixture(true); await f.manager.shutdown();
    const path = join(f.root, "data", "extensions.json"), state = JSON.parse(await readFile(path, "utf8"));
    state["qq-bot"].flowFingerprint = "3080cab4a372fa8fd07e295d458d1d6d59a9368adcb927c2b6ad4341a0b975cd";
    await writeFile(path, JSON.stringify(state));
    restored = new ExtensionManager(f.root, f.model, [f.item]); await restored.restore();
    for (let i = 0; i < 50 && restored.list()[0].state !== "connected"; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(restored.flowCatalog()[0].requestChain, true);
    assert.notEqual(JSON.parse(await readFile(path, "utf8"))["qq-bot"].flowFingerprint, state["qq-bot"].flowFingerprint);
    await restored.shutdown(); restored = undefined;
    const incompatible = structuredClone(f.item.flow); incompatible.nodes[0].inputs.value.required = false; f.item.flow = incompatible;
    restored = new ExtensionManager(f.root, f.model, [f.item]); await restored.restore();
    assert.equal(restored.list()[0].state, "error"); assert.equal(restored.flowCatalog()[0].status, "incompatible");
    await assert.rejects(restored.enable("qq-bot"), { code: "FLOW_CONTRACT_INVALID" });
  } finally { await restored?.shutdown(); await f?.close(); if (old === undefined) delete process.env.STARDUST_QQ_INPUT_FLOW; else process.env.STARDUST_QQ_INPUT_FLOW = old; }
});

test("concurrent flow events preserve the original queue limit", async () => {
  const old = process.env.STARDUST_QQ_INPUT_FLOW; let f;
  try {
    f = await fixture(true);
    const requests = Array.from({ length: 21 }, (_, i) => f.bot.emit(event("c2c", `concurrent-${i}`, { replyTarget: { scope: "c2c", targetId: `session-${i}`, msgId: `concurrent-${i}` } })));
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.manager.capabilityTargets("qq-bot").length, 20);
    await f.manager.disable("qq-bot"); await Promise.all(requests);
    assert.ok(f.model.calls.length <= 1);
  } finally { await f?.close(); if (old === undefined) delete process.env.STARDUST_QQ_INPUT_FLOW; else process.env.STARDUST_QQ_INPUT_FLOW = old; }
});
