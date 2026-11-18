import assert from "node:assert/strict";
import { test } from "node:test";
import { flowGraphs, flowViews, visibleFlowGraph } from "../apps/web/dist/flow-data.js";

const graph = id => flowGraphs.find(item => item.id === id);
const edge = (item, id) => item.edges.find(value => value.id === id);

test("feature graphs have stable unique nodes and valid local edges", () => {
  assert.equal(new Set(flowGraphs.map(item => item.id)).size, flowGraphs.length);
  assert.deepEqual(flowViews.map(view => view.id), ["all", "web", "qq"]);
  for (const item of flowGraphs) {
    const nodes = new Map(item.nodes.map(node => [node.id, node]));
    assert.equal(nodes.size, item.nodes.length);
    assert.equal(new Set(item.edges.map(link => link.id)).size, item.edges.length);
    for (const link of item.edges) { assert.ok(nodes.has(link.source)); assert.ok(nodes.has(link.target)); assert.ok(link.relation); }
    for (const node of item.nodes.filter(node => node.childGraphId)) assert.equal(graph(node.childGraphId)?.parentId, item.id);
  }
});

test("overview links to each feature graph and keeps Tool optional", () => {
  assert.deepEqual(flowGraphs.map(item => item.id), ["overview", "input", "context", "model", "tool", "output"]);
  const overview = graph("overview");
  assert.deepEqual(overview.nodes.map(node => node.childGraphId), ["input", "context", "model", "tool", "output"]);
  assert.ok(flowGraphs.slice(1).every(item => item.parentId === overview.id));
  assert.ok(overview.edges.some(link => link.source === "model" && link.target === "output"));
  assert.ok(overview.edges.some(link => link.source === "model" && link.target === "tool"));
  assert.ok(overview.edges.some(link => link.source === "tool" && link.target === "model"));
  assert.deepEqual(visibleFlowGraph(overview, "web").nodes.map(node => node.id), ["input", "context", "model", "tool", "output"]);
  const qq = visibleFlowGraph(overview, "qq");
  assert.deepEqual(qq.nodes.map(node => node.id), ["input", "context", "model", "output"]);
  assert.ok(qq.edges.every(link => link.source !== "tool" && link.target !== "tool"));
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
  assert.deepEqual(model.nodes.find(node => node.id === "skill").views,["web"]);
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

test("channel views contain only their own cards and connected paths", () => {
  const input = graph("input");
  const web = visibleFlowGraph(input, "web");
  const qq = visibleFlowGraph(input, "qq");
  assert.deepEqual(web.nodes.map(node => node.id), ["web-input", "channel-entry"]);
  assert.deepEqual(qq.nodes.map(node => node.id), ["qq-input", "channel-entry"]);
  assert.deepEqual(web.edges.map(link => link.id), ["web-to-agent"]);
  assert.deepEqual(qq.edges.map(link => link.id), ["qq-to-agent"]);
  const context = visibleFlowGraph(graph("context"), "qq");
  assert.deepEqual(context.nodes.map(node => node.id), ["current", "context-output"]);
  assert.deepEqual(context.edges.map(link => link.id), ["qq-current-output"]);
  for (const item of [web, qq, context]) {
    const ids = new Set(item.nodes.map(node => node.id));
    assert.ok(item.edges.every(link => ids.has(link.source) && ids.has(link.target)));
  }
  assert.equal(input.nodes.length, 3, "view selection does not mutate the source graph");
});

test("Skill is shown only for the optional Web request path", () => {
  for (const view of ["web", "qq"]) {
    const model = visibleFlowGraph(graph("model"), view);
    assert.equal(model.nodes.some(node => node.id === "skill"), view === "web");
    assert.equal(model.edges.some(link => link.id === "skill-web"), view === "web");
    assert.equal(model.nodes.some(node => node.id === "channel-prompt"), view === "web");
  }
});
