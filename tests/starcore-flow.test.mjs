import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveStarcoreInterfaces, StarcoreFlowRegistry, validateStarcoreFlow } from "../apps/server/dist/starcore-flow.js";
import { webChatExtension } from "../apps/server/dist/extensions/web-chat.js";
import { qqBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";

const cleanup = dir => { const rel = relative(tmpdir(), dir); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); rmSync(dir, { recursive: true, force: true }); };
function mock(owner = "demo") {
  const manifest = { id: owner, name: owner, version: "1.0.0", type: "channel", fields: [], description: "mock" };
  const type = `${owner}:filter`, group = `${owner}:root`, child = `${owner}:child`;
  const input = [{ id: "in", node: "input", required: true, label: "渠道输入" }], output = [{ id: "out", node: "output", label: "Core 输出" }];
  const edge = (from, to, port = "value", out = "value") => ({ from: { node: from, port: out }, to: { node: to, port } });
  const graph = { protocol: 1, owner, packageVersion: manifest.version, nodes: [{ id: type, owner, name: "过滤", description: "说明节点", category: "channel", role: "node", inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" } }, executable: false, capability: "channel" }], groups: [{ id: group, owner, name: "入口", description: "只读结构", editable: false, flow: { version: 1, rootId: group, graphs: [
    { id: group, nodes: [{ id: "input", type: "input" }, { id: "g", type: "group", graphId: child }, { id: "output", type: "output" }], edges: [edge("input", "g", "in"), edge("g", "output", "value", "out")], interface: { inputs: input, outputs: output } },
    { id: child, nodes: [{ id: "input", type: "input" }, { id: "n", type }, { id: "output", type: "output" }], edges: [edge("input", "n"), edge("n", "output")], interface: { inputs: input, outputs: output } },
  ] } }] };
  return { manifest, flow: graph, create(_config, host) { return { start() { host.status("connected"); }, stop() {} }; } };
}

test("Web, QQ and another starcore register against common graph contracts", () => {
  const registry = new StarcoreFlowRegistry();
  for (const item of [webChatExtension, qqBotExtension, mock()]) {
    registry.register(item.manifest, item.flow, (item.tools ?? []).map(t => t.name));
    assert.equal(registry.get(item.manifest.id).owner, item.manifest.id);
  }
  const web = registry.get("web-chat"); assert.equal(web.groups[0].flow.graphs[1].interface.inputs[0].label, "Web 对话请求");
  const iface = resolveStarcoreInterfaces(web).find(item => item.graphId === "web-chat:context");
  assert.deepEqual([iface.inputs[0].id, iface.inputs[0].type, iface.inputs[0].required, iface.outputs[0].type], ["current", "string", true, "json"]);
  const qq = registry.get("qq-bot"); assert.equal(qq.groups[0].flow.graphs[0].interface.inputs[0].label, "QQ 入站消息");
  assert.ok(qq.nodes.every(n => n.executable)); assert.throws(() => registry.execute(), /FLOW_ADAPTER_UNAVAILABLE/);
  assert.throws(() => registry.register(webChatExtension.manifest, webChatExtension.flow), /DUPLICATE_FLOW_OWNER/);
});

test("namespaces, capabilities, ports, references, cycles and interfaces are validated", () => {
  const item = mock(), validate = flow => validateStarcoreFlow(item.manifest, flow, []);
  let flow = structuredClone(item.flow); flow.nodes[0].id = "web-chat:filter"; assert.throws(() => validate(flow), /INVALID_FLOW_NODE/);
  flow = structuredClone(item.flow); flow.nodes.push(structuredClone(flow.nodes[0])); assert.throws(() => validate(flow), /INVALID_FLOW_NODE/);
  flow = structuredClone(item.flow); flow.nodes[0].inputs.value.type = "tool"; assert.throws(() => validate(flow), /INVALID_FLOW_PORTS/);
  flow = structuredClone(item.flow); flow.groups[0].flow.graphs[0].nodes[1].graphId = "demo:absent"; assert.throws(() => validate(flow), /UNKNOWN_GRAPH/);
  flow = structuredClone(item.flow); flow.groups[0].flow.graphs[1].nodes.push({ id: "cycle", type: "group", graphId: "demo:root" }); assert.throws(() => validate(flow), /GROUP_CYCLE/);
  flow = structuredClone(item.flow); flow.groups[0].flow.graphs[0].edges[0].to.port = "fake"; assert.throws(() => validate(flow), /INVALID_PORT/);
  flow = structuredClone(item.flow); flow.groups[0].flow.graphs[1].interface.inputs[0].label = ""; assert.throws(() => validate(flow), /FLOW_INTERFACE_LABEL_REQUIRED/);
  flow = structuredClone(item.flow); flow.nodes[0].executable = true; flow.nodes[0].adapter = "core:web-context"; assert.throws(() => validate(flow), /FLOW_ADAPTER_UNTRUSTED/);
  flow = structuredClone(item.flow); flow.nodes[0].capability = "tool:send_message"; assert.throws(() => validate(flow), /FLOW_CAPABILITY_UNAVAILABLE/);
  flow = structuredClone(item.flow); flow.protocol = 2; assert.throws(() => validate(flow), /FLOW_CONTRACT_INCOMPATIBLE/);
  const forgedWeb = structuredClone(webChatExtension.flow); forgedWeb.nodes[0].id = "web-chat:pretend";
  assert.throws(() => validateStarcoreFlow(webChatExtension.manifest, forgedWeb, []), /FLOW_ADAPTER_UNTRUSTED/);
  const mutatedWeb = structuredClone(webChatExtension.flow); mutatedWeb.nodes[0].outputs.value.type = "string";
  assert.throws(() => validateStarcoreFlow(webChatExtension.manifest, mutatedWeb, []), /FLOW_ADAPTER_UNTRUSTED/);
  flow = structuredClone(item.flow); const graph = flow.groups[0].flow.graphs[1];
  graph.nodes.push({ id: "unused", type: "input" }); graph.interface.inputs = [...graph.interface.inputs, { id: "unused", node: "unused", required: false, label: "备用输入" }];
  assert.ok(validate(flow).warnings.some(w => w.endsWith("INPUT_UNCONNECTED")));
});

test("starcore lifecycle disables and restores declarations and detects incompatible upgrades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stardust-star-flow-")), item = mock(); let manager;
  try {
    manager = new ExtensionManager(dir, { chat: async () => "mock" }, [item]);
    assert.equal(manager.flowCatalog()[0].status, "uninstalled");
    await manager.install("demo"); assert.equal(manager.flowCatalog()[0].status, "disabled");
    await manager.enable("demo"); assert.equal(manager.flowCatalog()[0].status, "enabled");
    await manager.disable("demo"); assert.equal(manager.flowCatalog()[0].status, "disabled");
    assert.equal(manager.flowCatalog()[0].contract.groups[0].id, "demo:root");
    await manager.enable("demo"); assert.equal(manager.flowCatalog()[0].status, "enabled");
    await manager.shutdown();
    const changed = mock(); changed.manifest.version = "2.0.0"; changed.flow.packageVersion = "2.0.0"; changed.flow.nodes[0].inputs.value.required = false;
    manager = new ExtensionManager(dir, { chat: async () => "mock" }, [changed]);
    assert.equal(manager.flowCatalog()[0].status, "incompatible"); await assert.rejects(manager.enable("demo"), { code: "FLOW_CONTRACT_INCOMPATIBLE" });
    await manager.shutdown(); manager = new ExtensionManager(dir, { chat: async () => "mock" }, [item]);
    await manager.uninstall("demo", false); assert.equal(manager.flowCatalog()[0].status, "uninstalled");
    await manager.install("demo"); await manager.enable("demo"); assert.equal(manager.flowCatalog()[0].status, "enabled");
  } finally { await manager?.shutdown(); cleanup(dir); }
});
