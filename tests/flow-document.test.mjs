import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addCustomNode, connectNodes, defaultFlowDocument, moveNodeIntoGroup,
  parseFlowDocument, removeEdge, removeNode,
} from "../apps/web/dist/flow-document.js";

test("custom nodes, groups, connections and nested graphs survive serialization", () => {
  const document = defaultFlowDocument();
  const group = addCustomNode(document, "overview", "context", { x: 20, y: 30 }, true);
  const nested = addCustomNode(document, "overview", "context", { x: 60, y: 30 }, true);
  const note = addCustomNode(document, "overview", "context", { x: 100, y: 30 });
  const edge = connectNodes(document, "overview", note.id, "out", group.id, "in");
  assert.throws(() => connectNodes(document, "overview", note.id, "out", group.id, "in"), /已经连接/);
  assert.throws(() => connectNodes(document, "overview", note.id, "in", group.id, "out"), /端口/);
  assert.throws(() => connectNodes(document, "overview", note.id, "out", note.id, "in"), /不同节点/);
  assert.throws(() => moveNodeIntoGroup(document, "overview", note.id, group.id), /连线/);
  removeEdge(document, "overview", edge.id);
  assert.throws(() => removeEdge(document, "overview", edge.id), /找不到/);
  moveNodeIntoGroup(document, "overview", nested.id, group.id);
  moveNodeIntoGroup(document, "overview", note.id, group.id);
  const restored = parseFlowDocument(JSON.parse(JSON.stringify(document)));
  assert.equal(restored.graphs.find((item) => item.id === group.childGraphId).nodes.length, 4);
  assert.equal(restored.graphs.find((item) => item.id === nested.childGraphId).parentId, group.childGraphId);
  assert.throws(() => removeNode(restored, "overview", group.id), /清空/);
  assert.throws(() => removeNode(restored, "overview", "input"), /系统节点/);
  removeNode(restored, group.childGraphId, note.id);
  assert.equal(restored.graphs.find((item) => item.id === group.childGraphId).nodes.some((item) => item.id === note.id), false);
});

test("malformed references, group cycles, and forged system nodes are rejected", () => {
  assert.throws(() => parseFlowDocument(null));
  const broken = defaultFlowDocument();
  broken.graphs[0].edges[0].source = "missing";
  assert.throws(() => parseFlowDocument(broken), /连线/);
  const forged = defaultFlowDocument();
  forged.graphs[0].nodes[0].kind = "tool";
  assert.throws(() => parseFlowDocument(forged), /系统节点/);
  const malformedLayout = defaultFlowDocument();
  malformedLayout.graphs[0].nodes[0].positionByView = { web: { x: "bad", y: 0 } };
  assert.throws(() => parseFlowDocument(malformedLayout), /布局/);
  const malformedInterface = defaultFlowDocument();
  malformedInterface.graphs.find((item) => item.id === "context").interface.inputs[0].nodeId = "other";
  assert.throws(() => parseFlowDocument(malformedInterface), /接口/);
  const cycle = defaultFlowDocument();
  const group = addCustomNode(cycle, "overview", "context", { x: 0, y: 0 }, true);
  cycle.graphs.find((item) => item.id === group.childGraphId).parentId = group.childGraphId;
  assert.throws(() => parseFlowDocument(cycle));
});
