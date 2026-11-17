import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowRegistry, executeFlow, validateExecutableFlow } from "../apps/server/dist/executable-flow.js";

const node = (id, type = "pass", extra = {}) => ({ id, type, ...extra });
const edge = (from, to, port = "value", fromPort = "value") => ({ from: { node: from, port: fromPort }, to: { node: to, port } });
const graph = (id, nodes, edges) => ({ id, nodes, edges, interface: { inputs: [{ id: "in", node: "in", required: true }], outputs: [{ id: "out", node: "out" }] } });
const flow = (...graphs) => ({ version: 1, rootId: graphs[0].id, graphs });
const run = (f, registry = createFlowRegistry(), inputs = { in: "x" }, options) => executeFlow(f, registry, inputs, options);
const status = (result, ...path) => result.nodes.find(n => n.path.join("/") === path.join("/"))?.status;
const tap = (registry, calls, type = "tap", sideEffect = false) => registry.register(type, {
  role: "node", sideEffect, inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" } },
  execute: inputs => { calls.push(type); return { value: inputs.value + type }; },
});

test("A/B: connections drive execution and isolated nodes are skipped", async () => {
  const calls = [], registry = createFlowRegistry(); tap(registry, calls, "A"); tap(registry, calls, "B");
  const f = flow(graph("root", [node("in", "input"), node("a", "A"), node("b", "B"), node("out", "output")], [edge("in", "a"), edge("a", "b"), edge("b", "out")]));
  let result = await run(f, registry);
  assert.equal(result.status, "succeeded"); assert.equal(result.outputs.out, "xAB"); assert.deepEqual(calls, ["A", "B"]);
  calls.length = 0; f.graphs[0].edges = [edge("in", "a"), edge("a", "out")];
  result = await run(f, registry);
  assert.equal(result.outputs.out, "xA"); assert.deepEqual(calls, ["A"]); assert.equal(status(result, "b"), "skipped");
});

test("C: disconnected optional input no longer invokes its source", async () => {
  const calls = [], registry = createFlowRegistry(); tap(registry, calls, "source");
  const f = flow(graph("root", [node("in", "input"), node("source", "source"), node("merge", "merge"), node("out", "output")], [edge("in", "merge"), edge("in", "source"), edge("source", "merge", "optional"), edge("merge", "out")]));
  let result = await run(f, registry); assert.equal(result.outputs.out, "xxsource"); assert.deepEqual(calls, ["source"]);
  calls.length = 0; f.graphs[0].edges.splice(2, 1);
  result = await run(f, registry); assert.equal(result.outputs.out, "x"); assert.deepEqual(calls, []); assert.equal(status(result, "source"), "skipped");
});

test("D: missing required dependency fails validation before any node runs", async () => {
  const calls = [], registry = createFlowRegistry(); tap(registry, calls);
  const f = flow(graph("root", [node("in", "input"), node("tap", "tap"), node("out", "output")], [edge("tap", "out")]));
  await assert.rejects(run(f, registry), /MISSING_REQUIRED_INPUT: tap.value/); assert.deepEqual(calls, []);
  assert.throws(() => validateExecutableFlow(f, registry), /MISSING_REQUIRED_INPUT/);
});

test("E: nested group interfaces map values across two levels", async () => {
  const leaf = graph("leaf", [node("in", "input"), node("suffix", "transform", { config: { suffix: "!" } }), node("out", "output")], [edge("in", "suffix"), edge("suffix", "out")]);
  const middle = graph("middle", [node("in", "input"), node("groupB", "group", { graphId: "leaf" }), node("out", "output")], [edge("in", "groupB", "in"), edge("groupB", "out", "value", "out")]);
  const root = graph("root", [node("in", "input"), node("before", "transform", { config: { suffix: "." } }), node("groupA", "group", { graphId: "middle" }), node("out", "output")], [edge("in", "before"), edge("before", "groupA", "in"), edge("groupA", "out", "value", "out")]);
  const result = await run(flow(root, middle, leaf));
  assert.equal(result.status, "succeeded"); assert.equal(result.outputs.out, "x.!"); assert.equal(status(result, "groupA", "groupB", "suffix"), "succeeded");
});

test("group planning only pulls inputs and branches contributing to requested outputs", async () => {
  const calls = [], registry = createFlowRegistry(); tap(registry, calls, "extra");
  const child = {
    id: "child", nodes: [node("first", "input"), node("second", "input"), node("one", "output"), node("two", "output")],
    edges: [edge("first", "one"), edge("second", "two")],
    interface: { inputs: [{ id: "first", node: "first", required: true }, { id: "second", node: "second", required: true }], outputs: [{ id: "one", node: "one" }, { id: "two", node: "two" }] },
  };
  const root = graph("root", [node("in", "input"), node("extra", "extra"), node("g", "group", { graphId: "child" }), node("out", "output")], [edge("in", "g", "first"), edge("in", "extra"), edge("extra", "g", "second"), edge("g", "out", "value", "one")]);
  let result = await run(flow(root, child), registry);
  assert.equal(result.status, "succeeded"); assert.equal(result.outputs.out, "x"); assert.deepEqual(calls, []); assert.equal(status(result, "extra"), "skipped"); assert.equal(status(result, "g", "two"), "skipped");
  result = await run(flow(root, child), registry, { in: "x" }, { targets: ["g"] });
  assert.equal(result.status, "succeeded"); assert.deepEqual(calls, ["extra"]);
});

test("F/H: invalid graphs and forged capabilities are rejected", async () => {
  const registry = createFlowRegistry();
  const base = () => flow(graph("root", [node("in", "input"), node("out", "output")], [edge("in", "out")]));
  let f = base(); f.graphs[0].edges[0].from.port = "unknown"; assert.throws(() => validateExecutableFlow(f, registry), /INVALID_PORT/);
  f = base(); f.graphs[0].edges[0].from.port = "toString"; assert.throws(() => validateExecutableFlow(f, registry), /INVALID_PORT/);
  registry.register("numeric", { role: "node", inputs: { value: { type: "number", required: true } }, outputs: {}, execute: () => ({}) });
  f = base(); f.graphs[0].nodes.push(node("n", "numeric")); f.graphs[0].edges.push(edge("in", "n")); assert.throws(() => validateExecutableFlow(f, registry), /PORT_TYPE_MISMATCH/);
  f = base(); f.graphs[0].nodes.push(node("evil", "tool")); assert.throws(() => validateExecutableFlow(f, registry), /UNKNOWN_NODE_TYPE/);
  f = base(); f.graphs[0].nodes[0].ports = [{ id: "value", type: "tool", permission: "all" }]; assert.throws(() => validateExecutableFlow(f, registry), /INVALID_SCHEMA/);
  f = base(); f.graphs[0].nodes.push(node("g", "group", { graphId: "root" })); assert.throws(() => validateExecutableFlow(f, registry), /GROUP_CYCLE/);
  const other = graph("other", [node("in", "input"), node("g", "group", { graphId: "root" }), node("out", "output")], []);
  f = base(); f.graphs[0].nodes.push(node("g", "group", { graphId: "other" })); f.graphs.push(other); assert.throws(() => validateExecutableFlow(f, registry), /GROUP_CYCLE/);
  f = base(); f.graphs[0].nodes.push(node("a"), node("b")); f.graphs[0].edges.push(edge("a", "b"), edge("b", "a")); assert.throws(() => validateExecutableFlow(f, registry), /GRAPH_CYCLE/);
  f = base(); f.graphs[0].edges.push(edge("in", "out")); assert.throws(() => validateExecutableFlow(f, registry), /DUPLICATE_INPUT/);
});

test("G: side effect metadata cannot cause an isolated branch to run", async () => {
  const calls = [], registry = createFlowRegistry(); tap(registry, calls, "effect", true);
  const f = flow(graph("root", [node("in", "input"), node("effect", "effect"), node("out", "output")], [edge("in", "out"), edge("in", "effect")]));
  const result = await run(f, registry); assert.equal(result.status, "succeeded"); assert.deepEqual(calls, []); assert.equal(status(result, "effect"), "skipped");
  const targeted = await run(f, registry, { in: "x" }, { targets: ["effect"] });
  assert.equal(targeted.error, "SIDE_EFFECT_UNAVAILABLE: effect"); assert.deepEqual(calls, []);
});

test("failure, missing values, cancellation and skipped nodes have distinct states", async () => {
  const registry = createFlowRegistry();
  registry.register("fail", { role: "node", inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" } }, execute: () => { throw new Error("BROKEN"); } });
  const f = flow(graph("root", [node("in", "input"), node("bad", "fail"), node("out", "output")], [edge("in", "bad"), edge("bad", "out")]));
  let result = await run(f, registry); assert.equal(result.status, "failed"); assert.equal(result.error, "BROKEN"); assert.equal(status(result, "bad"), "failed"); assert.equal(status(result, "out"), "skipped");
  result = await run(f, registry, {}); assert.equal(result.error, "MISSING_ENTRY_VALUE: in"); assert.equal(status(result, "in"), "failed");
  const controller = new AbortController(); controller.abort(); result = await run(f, registry, { in: "x" }, { signal: controller.signal });
  assert.equal(result.status, "cancelled"); assert.equal(status(result, "in"), "cancelled"); assert.equal(status(result, "out"), "skipped");
});

test("in-flight cancellation propagates through groups without starting downstream nodes", async () => {
  const registry = createFlowRegistry(), controller = new AbortController(), calls = [];
  registry.register("cancel", { role: "node", inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" } }, execute: i => { controller.abort(); return { value: i.value }; } });
  tap(registry, calls);
  const child = graph("child", [node("in", "input"), node("cancel", "cancel"), node("out", "output")], [edge("in", "cancel"), edge("cancel", "out")]);
  const root = graph("root", [node("in", "input"), node("g", "group", { graphId: "child" }), node("tap", "tap"), node("out", "output")], [edge("in", "g", "in"), edge("g", "tap", "value", "out"), edge("tap", "out")]);
  const result = await run(flow(root, child), registry, { in: "x" }, { signal: controller.signal });
  assert.equal(result.status, "cancelled"); assert.equal(status(result, "g", "cancel"), "cancelled"); assert.equal(status(result, "g"), "cancelled"); assert.equal(status(result, "tap"), "skipped"); assert.deepEqual(calls, []);
});

test("connected control ports are dependencies; absent output values fail explicitly", async () => {
  const registry = createFlowRegistry();
  registry.register("gate", { role: "node", inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" }, ready: { type: "control" } }, execute: i => ({ value: i.value, ready: true }) });
  registry.register("controlled", { role: "node", inputs: { value: { type: "string", required: true }, go: { type: "control", required: true } }, outputs: { value: { type: "string" } }, execute: i => ({ value: i.value }) });
  const f = flow(graph("root", [node("in", "input"), node("gate", "gate"), node("controlled", "controlled"), node("out", "output")], [edge("in", "gate"), edge("gate", "controlled"), edge("gate", "controlled", "go", "ready"), edge("controlled", "out")]));
  assert.equal((await run(f, registry)).outputs.out, "x");
  f.graphs[0].edges.splice(2, 1); await assert.rejects(run(f, registry), /MISSING_REQUIRED_INPUT: controlled.go/);
  const absent = createFlowRegistry(); absent.register("empty", { role: "node", inputs: { value: { type: "string", required: true } }, outputs: { value: { type: "string" } }, execute: () => ({}) });
  const g = flow(graph("root", [node("in", "input"), node("empty", "empty"), node("out", "output")], [edge("in", "empty"), edge("empty", "out")]));
  assert.equal((await run(g, absent)).error, "MISSING_REQUIRED_VALUE: out.value");
});
