import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, copyNode, exampleProject, linkBoard, newBoard, newNode, parseProject, removeNode } from "../apps/web/dist/flow-project.js";

test("project nodes, ports, groups and connections survive serialization and group copying", () => {
  const project = exampleProject(), root = project.boards[0], child = project.boards[1];
  const first = newNode("a"), second = newNode("b");
  child.nodes.push(first, second);
  assert.equal(connect(child, first, first.outputPorts[0], second, second.inputPorts[0]), true);
  assert.equal(connect(child, first, first.outputPorts[0], second, second.inputPorts[0]), false);
  assert.equal(connect(child, first, first.inputPorts[0], second, second.outputPorts[0]), false);
  assert.equal(connect(child, first, first.outputPorts[0], first, first.inputPorts[0]), false);
  const group = root.nodes.find(node => node.childBoardId === child.id);
  const copy = copyNode(project, root, group);
  const cloned = project.boards.find(board => board.id === copy.childBoardId);
  assert.equal(cloned.edges.length, child.edges.length);
  assert.notEqual(cloned.nodes.at(-1).id, second.id);
  removeNode(cloned, cloned.nodes.at(-1).id);
  assert.ok(child.nodes.includes(second));
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test("project validation rejects malformed nodes, edges and cyclic group references", () => {
  assert.throws(() => parseProject(null));
  const broken = exampleProject();
  broken.boards[0].edges[0].fromNodeId = "missing";
  assert.throws(() => parseProject(broken));
  const malformed = exampleProject();
  malformed.boards[0].nodes[0].position.x = "bad";
  assert.throws(() => parseProject(malformed));
  const cycle = exampleProject();
  const child = cycle.boards[1], entry = newNode();
  child.nodes.push(entry);
  assert.throws(() => linkBoard(cycle, child, entry, cycle.rootBoardId));
  entry.childBoardId = cycle.rootBoardId;
  assert.throws(() => parseProject(cycle));
  const unrelated = newBoard("独立");
  cycle.boards.push(unrelated);
});
