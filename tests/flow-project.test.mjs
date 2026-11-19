import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EDGE_APPEARANCE, MAX_BOARDS, PORT_SIDES, boardReferences, connect, copyNode, exampleProject, linkBoard, newBoard, newNode,
  parseProject, portSide, referenceTargets, removeBoard, removeNode, removePort,
} from '../apps/web/dist/flow-project.js';

test('V1 projects preserve boards, positions, ports, edges and viewports in a JSON round trip', () => {
  const project = exampleProject();
  const board = newBoard('独立画板'); board.viewport = { x: 35, y: -42, scale: .7 }; project.boards.push(board);
  project.boards[0].viewport = { x: -10, y: 20, scale: 1.2 };
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test('legacy ports and edges resolve to V1 defaults without rewriting saved fields', () => {
  const project = parseProject(exampleProject());
  const board = project.boards[0];
  const node = board.nodes[0];
  const edge = board.edges[0];
  assert.equal(portSide(node.inputPorts[0], 'input'), 'left');
  assert.equal(portSide(node.outputPorts[0], 'output'), 'right');
  assert.equal(node.inputPorts[0].side, undefined);
  assert.deepEqual({ ...DEFAULT_EDGE_APPEARANCE, ...edge.appearance }, { lineStyle: 'solid', pathStyle: 'bezier' });
  assert.equal(edge.semantic ?? 'unspecified', 'unspecified');
});

test('V1 JSON round-trips explicit port sides, appearance and independently assigned semantics', () => {
  const project = exampleProject();
  const [root, child] = project.boards;
  const [from, to] = root.nodes;
  const original = root.edges[0];
  for (const [index, side] of PORT_SIDES.entries()) {
    root.nodes[index].inputPorts[0].side = side;
    root.nodes[index].outputPorts[0].side = PORT_SIDES[PORT_SIDES.length - 1 - index];
  }
  linkBoard(project, root, from, child.id);
  assert.equal(connect(root, from, from.outputPorts[0], to, to.inputPorts[0]), true);
  assert.equal(connect(root, from, from.outputPorts[0], to, to.inputPorts[0]), false);
  assert.equal(connect(root, from, from.outputPorts[0], to, to.outputPorts[0]), false);
  assert.equal(connect(root, from, from.inputPorts[0], to, to.inputPorts[0]), false);
  original.appearance = { lineStyle: 'dashed', pathStyle: 'orthogonal' };
  original.semantic = 'data';
  root.edges.at(-1).appearance = { lineStyle: 'solid' };
  root.edges.at(-1).semantic = 'optional';
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test('ports permit fan-in and fan-out, reject duplicates, and clean up edges', () => {
  const board = newBoard(), [a,b,c] = ['a','b','c'].map(name => newNode(name)); board.nodes.push(a,b,c);
  assert.equal(connect(board,a,a.outputPorts[0],b,b.inputPorts[0]),true);
  assert.equal(connect(board,a,a.outputPorts[0],c,c.inputPorts[0]),true);
  assert.equal(connect(board,b,b.outputPorts[0],c,c.inputPorts[0]),true);
  assert.equal(connect(board,a,a.outputPorts[0],b,b.inputPorts[0]),false);
  assert.equal(connect(board,a,a.inputPorts[0],b,b.inputPorts[0]),false);
  removePort(board,a,a.outputPorts[0].id); assert.equal(board.edges.length,1);
  removeNode(board,c.id); assert.equal(board.edges.length,0);
});

test('copies preserve sharing within a recursively cloned group, independently of the originals', () => {
  const project = exampleProject();
  const [root, child] = project.boards;
  const group = root.nodes.find(node => node.childBoardId);
  child.nodes[0].outputPorts[0].side = 'bottom';
  child.edges[0].appearance = { lineStyle: 'dotted', pathStyle: 'orthogonal' };
  child.edges[0].semantic = 'feedback';
  const nested = newBoard('nested');
  const leaf = newBoard('长'.repeat(120));
  const external = newBoard('external');
  const [direct, viaNested, alsoDirect, inside, outside] = ['direct', 'via', 'same parent', 'inside', 'outside'].map(name => newNode(name));
  child.nodes.push(direct, viaNested, alsoDirect);
  nested.nodes.push(inside);
  external.nodes.push(outside);
  leaf.nodes.push(newNode('shared detail'));
  leaf.viewport = { x: 10, y: 30, scale: .7 };
  project.boards.push(nested, leaf, external);
  linkBoard(project, child, direct, leaf.id);
  linkBoard(project, child, alsoDirect, leaf.id);
  linkBoard(project, child, viaNested, nested.id);
  linkBoard(project, nested, inside, leaf.id);
  linkBoard(project, external, outside, leaf.id);

  const original = structuredClone(project);
  const copy = copyNode(project, root, group);
  const childCopy = project.boards.find(board => board.id === copy.childBoardId);
  const nestedCopy = project.boards.find(board => board.id === childCopy.nodes.at(-2).childBoardId);
  const leafCopy = project.boards.find(board => board.id === childCopy.nodes.at(-3).childBoardId);
  assert.equal(project.boards.length, original.boards.length + 3);
  assert.equal(childCopy.nodes.at(-1).childBoardId, leafCopy.id);
  assert.equal(nestedCopy.nodes[0].childBoardId, leafCopy.id);
  assert.notEqual(leafCopy.id, leaf.id);
  assert.notEqual(copy.id, group.id);
  assert.notEqual(copy.inputPorts[0].id, group.inputPorts[0].id);
  assert.notEqual(copy.outputPorts[0].id, group.outputPorts[0].id);
  assert.deepEqual(root.edges, original.boards[0].edges);
  assert.equal(childCopy.edges.length, child.edges.length);
  assert.equal(childCopy.nodes[0].outputPorts[0].side, 'bottom');
  assert.equal(childCopy.edges[0].fromPortId, childCopy.nodes[0].outputPorts[0].id);
  assert.equal(childCopy.edges[0].semantic, 'feedback');
  assert.deepEqual(childCopy.edges[0].appearance, child.edges[0].appearance);
  childCopy.edges[0].appearance.lineStyle = 'solid';
  assert.deepEqual(leafCopy.viewport, leaf.viewport);
  leafCopy.viewport.x = 99;
  childCopy.nodes[0].title = 'changed';
  leafCopy.nodes[0].title = 'changed copy';
  assert.deepEqual([child, nested, leaf, external], original.boards.slice(1));
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test('copying a regular card keeps its content and leaves its external links on the original', () => {
  const project = exampleProject();
  const root = project.boards[0];
  const original = root.nodes[0];
  original.subtitle = '说明';
  const copy = copyNode(project, root, original);
  assert.notEqual(copy.id, original.id);
  assert.notEqual(copy.inputPorts[0].id, original.inputPorts[0].id);
  assert.notEqual(copy.outputPorts[0].id, original.outputPorts[0].id);
  assert.equal(copy.title, original.title);
  assert.equal(copy.subtitle, original.subtitle);
  assert.equal(copy.visualStyle, original.visualStyle);
  assert.ok(!root.edges.some(edge => edge.fromNodeId === copy.id || edge.toNodeId === copy.id));
  assert.equal(project.boards.length, 2);
});

test('a copy that exceeds the project board limit leaves the project untouched', () => {
  const project = exampleProject();
  const [root, child] = project.boards;
  const leaf = newBoard();
  project.boards.push(leaf);
  linkBoard(project, child, child.nodes[0], leaf.id);
  while (project.boards.length < MAX_BOARDS - 1) project.boards.push(newBoard());
  const original = structuredClone(project);
  assert.throws(() => copyNode(project, root, root.nodes.find(node => node.childBoardId)), /上限/);
  assert.deepEqual(project, original);
});

test('link, replace, unlink and delete preserve shared board data and unrelated references', () => {
  const project = exampleProject();
  const [root, child] = project.boards;
  const qq = newBoard('QQ 星核');
  const leaf = newBoard('沙盒执行');
  const qqEntry = newNode('沙盒使用');
  qq.nodes.push(qqEntry);
  project.boards.push(qq, leaf);
  linkBoard(project, child, child.nodes[0], leaf.id);
  child.viewport = { x: 1, y: -42, scale: .5 };
  const originalChild = structuredClone(child);
  const originalLeaf = structuredClone(leaf);
  const [entry, linkedToChild] = [root.nodes[0], root.nodes[2]];

  linkBoard(project, qq, qqEntry, child.id);
  linkBoard(project, root, entry, child.id);
  assert.deepEqual(boardReferences(project, child.id), [
    { board: root, node: entry }, { board: root, node: linkedToChild }, { board: qq, node: qqEntry },
  ]);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
  assert.throws(() => removeBoard(project, root.id), /根画板/);
  assert.throws(() => removeBoard(project, child.id), /解除/);
  assert.deepEqual(child, originalChild);

  linkBoard(project, root, linkedToChild, leaf.id);
  assert.deepEqual(child, originalChild);
  assert.deepEqual(leaf, originalLeaf);
  removeNode(root, entry.id);
  assert.ok(!root.edges.some(edge => edge.fromNodeId === entry.id || edge.toNodeId === entry.id));
  assert.equal(qqEntry.childBoardId, child.id);
  assert.throws(() => removeBoard(project, child.id), /解除/);
  delete qqEntry.childBoardId;
  assert.deepEqual(child, originalChild);
  removeBoard(project, child.id);
  assert.ok(!project.boards.includes(child));
  assert.deepEqual(leaf, originalLeaf);
  assert.equal(linkedToChild.childBoardId, leaf.id);
  assert.deepEqual(parseProject(project), project);
});

test('available targets exclude self and all ancestors, and mutation rechecks the link', () => {
  const project = exampleProject();
  const [root, child] = project.boards;
  const [branchA, branchB, leaf, independent] = ['A', 'B', 'leaf', 'independent'].map(name => newBoard(name));
  for (const board of [branchA, branchB, leaf, independent]) board.nodes.push(newNode());
  project.boards.push(branchA, branchB, leaf, independent);
  linkBoard(project, root, root.nodes[0], branchA.id);
  linkBoard(project, root, root.nodes[1], branchB.id);
  linkBoard(project, branchA, branchA.nodes[0], leaf.id);
  linkBoard(project, branchB, branchB.nodes[0], leaf.id);
  assert.deepEqual(referenceTargets(project, leaf), [child, independent]);
  assert.throws(() => linkBoard(project, leaf, leaf.nodes[0], leaf.id), /循环/);
  assert.throws(() => linkBoard(project, leaf, leaf.nodes[0], root.id), /循环/);
  assert.throws(() => linkBoard(project, leaf, leaf.nodes[0], 'missing'), /目标/);
  assert.throws(() => linkBoard(project, leaf, newNode(), child.id), /卡片/);
  assert.equal(leaf.nodes[0].childBoardId, undefined);
  linkBoard(project, independent, independent.nodes[0], root.id);
  assert.deepEqual(parseProject(project), project);
});

test('import checks all boards for indirect cycles and supports deep acyclic paths', () => {
  const project = exampleProject();
  const chain = Array.from({ length: 120 }, () => newBoard());
  for (const [i, board] of chain.entries()) {
    const node = newNode();
    if (chain[i + 1]) node.childBoardId = chain[i + 1].id;
    board.nodes.push(node);
  }
  project.boards.push(...chain);
  assert.deepEqual(parseProject(project), project);
  chain.at(-1).nodes[0].childBoardId = chain[0].id;
  assert.throws(() => parseProject(project), /循环/);
});

test('untrusted imports reject unsupported versions, duplicate IDs, broken or cyclic references and invalid values', () => {
  const base=exampleProject(), root=base.boards[0], child=base.boards[1];
  const bad = [
    p=>p.schemaVersion=2,
    p=>p.boards[1].id=p.boards[0].id,
    p=>p.boards[0].nodes[0].position.x=Infinity,
    p=>p.boards[0].nodes[0].title={html:'bad'},
    p=>p.boards[0].nodes[0].inputPorts[0].side='diagonal',
    p=>p.boards[0].nodes[0].outputPorts[0].side=null,
    p=>p.boards[0].edges[0].toPortId='missing',
    p=>p.boards[0].edges[0].toNodeId=p.boards[1].nodes[0].id,
    p=>p.boards[0].edges[0].appearance={lineStyle:'striped'},
    p=>p.boards[0].edges[0].appearance={pathStyle:'arc'},
    p=>p.boards[0].edges[0].appearance=null,
    p=>p.boards[0].edges[0].semantic='execute',
    p=>p.boards[0].nodes[2].childBoardId='missing',
    p=>p.boards[1].nodes[0].childBoardId=root.id,
    p=>p.boards[1].nodes[0].childBoardId=child.id,
    p=>p.boards[0].edges.push({...p.boards[0].edges[0],id:'another-edge'}),
  ];
  for(const mutate of bad){const candidate=structuredClone(base);mutate(candidate);assert.throws(()=>parseProject(candidate));}
  assert.deepEqual(parseProject(base),base);
});
