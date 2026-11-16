import assert from "node:assert/strict";
import { test } from "node:test";
import { flowGraphs, flowViews } from "../apps/web/dist/flow-data.js";

const graph = id => flowGraphs.find(item => item.id === id);
const edge = (item, id) => item.edges.find(value => value.id === id);

test("feature graphs have stable unique nodes and valid local edges", () => {
  assert.equal(new Set(flowGraphs.map(item => item.id)).size, flowGraphs.length);
  assert.deepEqual(flowViews.map(view => view.id), ["web", "qq"]);
  for (const item of flowGraphs) {
    const nodes = new Map(item.nodes.map(node => [node.id, node]));
    assert.equal(nodes.size, item.nodes.length);
    assert.equal(new Set(item.edges.map(link => link.id)).size, item.edges.length);
    for (const link of item.edges) { assert.ok(nodes.has(link.source)); assert.ok(nodes.has(link.target)); assert.ok(link.relation); }
    for (const node of item.nodes.filter(node => node.childGraphId)) assert.equal(graph(node.childGraphId)?.parentId, item.id);
  }
});

test("only feature graphs are available", () => {
  assert.deepEqual(flowGraphs.map(item => item.id), ["input", "context", "model", "tool", "output"]);
  assert.ok(flowGraphs.every(item => !item.parentId));
});

test("Web-only history and background synthesis are not shown as QQ execution paths", () => {
  const context = graph("context");
  for (const id of ["recent", "global", "assembler", "completed-turn", "synthesis"]) {
    assert.ok(!context.nodes.find(node => node.id === id).views.includes("qq"));
    assert.ok(!context.edges.some(link => (link.source === id || link.target === id) && link.views.includes("qq")));
  }
  assert.deepEqual(edge(context,"qq-current-output").views,["qq"]);
  assert.equal(edge(context,"turn-synthesis").style,"dependency");
  assert.match(context.nodes.find(node => node.id === "recent").description, /50/);
  assert.match(context.nodes.find(node => node.id === "assembler").description, /36,000/);
  assert.ok(!graph("tool").availableViews.includes("qq"));
  const model = graph("model");
  assert.equal(model.nodes.find(node => node.id === "skill").planned,true);
  assert.ok(!model.nodes.find(node => node.id === "channel-prompt").views.includes("qq"));
});

test("Tool subgraph distinguishes read-only retrieval, confirmation, rejection and model result", () => {
  const tool = graph("tool");
  assert.deepEqual(tool.nodes.map(node=>node.id),["tool-request","tool-policy","history","approval","denied","executor","tool-result"]);
  assert.match(tool.nodes.find(node => node.id === "history").description, /按需/);
  assert.equal(edge(tool,"policy-history").target,"history");
  assert.equal(edge(tool,"approved-execute").target,"executor");
  assert.equal(edge(tool,"denied-result").target,"tool-result");
  assert.equal(edge(tool,"executor-result").target,"tool-result");
});
