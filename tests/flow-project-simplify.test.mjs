import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connect, exampleProject, newNode, parseProject } from "../apps/web/dist/flow-project.js";
import { layoutNode } from "../apps/web/dist/flow-project-geometry.js";
import { simplifyProject } from "../apps/web/dist/flow-project-simplify.js";
import { loadProject, MIGRATION_KEY, PROJECT_KEY, REPAIR_MARKER_KEY, SIMPLIFY_BACKUP_KEY, SIMPLIFY_MARKER_KEY } from "../apps/web/dist/flow-project-migration.js";
import { oldRelationsProject } from "./flow-project-repair-fixture.mjs";

const priorProject = () => parseProject(JSON.parse(readFileSync(new URL("./fixtures/flow-m5-c0-relations.json", import.meta.url), "utf8")));
const board = (project, name) => project.boards.find(item => item.name === name);
const named = (item, title) => item.nodes.find(node => node.title === title);
const hasEdge = (item, from, to, semantic) => item.edges.some(edge =>
  edge.fromNodeId === named(item, from)?.id && edge.toNodeId === named(item, to)?.id
  && (!semantic || edge.semantic === semantic));

class Storage {
  values = new Map();
  fail;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.fail?.(key, value)) throw new Error("storage failure");
    this.values.set(key, String(value));
  }
}

test("the default shows the shorter QQ flow and the intended context paths", () => {
  const project = exampleProject();
  const qq = board(project, "QQ 星核"), context = board(project, "上下文");
  assert.equal(qq.nodes.length, 8);
  for (const [from, to] of [
    ["QQ 消息接收", "输入过滤"], ["输入过滤", "输出：QQ 上下文"],
    ["输入：主流程回复", "QQ 消息发送"], ["Core 工具调用", "QQ msg Tool"],
    ["QQ msg Tool", "QQ 消息发送"],
  ]) assert.ok(hasEdge(qq, from, to));
  assert.ok(hasEdge(qq, "QQ msg Tool", "QQ 消息发送", "optional"));
  assert.equal(named(context, "Web Global Context"), undefined);
  assert.ok(hasEdge(context, "完整短期上下文", "输出：模型"));
  assert.ok(hasEdge(context, "退出短期窗口", "上下文压缩", "optional"));
  assert.ok(hasEdge(context, "普通压缩上下文池", "输出：模型", "optional"));
  assert.ok(named(context, "长期记忆").subtitle.includes("规划"));
  assert.equal(simplifyProject(project).changed, false);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test("updating the old design preserves changed positions, viewport and user-added content", () => {
  const original = priorProject(), qq = board(original, "QQ 星核");
  const context = board(original, "上下文");
  const userCard = newNode("用户添加", 2500, 150);
  qq.nodes.push(userCard);
  qq.viewport = { x: 3, y: 19, scale: .9 };
  named(qq, "QQ 上下文来源").position = { x: 610, y: 120 };
  const contextCard = newNode("用户笔记", 2400, 120);
  context.nodes.push(contextCard);
  const before = structuredClone(original);
  const result = simplifyProject(original);
  assert.equal(result.changed, true);
  assert.deepEqual(original, before);
  const nextQQ = board(result.project, "QQ 星核");
  assert.deepEqual(named(nextQQ, "用户添加"), userCard);
  assert.deepEqual(nextQQ.viewport, qq.viewport);
  assert.deepEqual(named(nextQQ, "输出：QQ 上下文").position, { x: 610, y: 120 });
  assert.deepEqual(named(board(result.project, "上下文"), "用户笔记"), contextCard);
  assert.deepEqual(board(result.project, "沙盒执行"), board(original, "沙盒执行"));
  assert.equal(simplifyProject(result.project).changed, false);
});

test("simplifying a pre-repair QQ board keeps the generated cards separated", () => {
  const qq = board(simplifyProject(oldRelationsProject()).project, "QQ 星核");
  for (const [index, node] of qq.nodes.entries()) {
    const a = layoutNode(node).bounds;
    for (const other of qq.nodes.slice(index + 1)) {
      const b = layoutNode(other).bounds;
      assert.ok(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
        `${node.title} 与 ${other.title} 重叠`);
    }
  }
});

test("user-added connections on a prior card are retained", () => {
  const original = priorProject();
  const context = board(original, "上下文");
  const global = named(context, "Web Global Context");
  const custom = newNode("用户连接", 2400, 120);
  context.nodes.push(custom);
  assert.equal(connect(context, global, global.outputPorts[0], custom, custom.inputPorts[0]), true);
  const result = board(simplifyProject(original).project, "上下文");
  assert.ok(named(result, "Web Global Context"));
  assert.ok(hasEdge(result, "Web Global Context", "用户连接"));
});

test("a customized sandbox reference keeps its existing destination", () => {
  const original = priorProject();
  const qq = board(original, "QQ 星核");
  named(qq, "沙盒能力引用").subtitle = "用户自定义的用途";
  const result = board(simplifyProject(original).project, "QQ 星核");
  assert.ok(hasEdge(result, "沙盒能力引用", "输出：沙盒能力"));
});

test("existing browser designs are backed up before one-time simplification", () => {
  const storage = new Storage();
  const prior = priorProject();
  named(board(prior, "主流程"), "QQ 消息").title = "用户自定义入口";
  const serialized = JSON.stringify(prior);
  storage.setItem(PROJECT_KEY, serialized);
  storage.setItem(MIGRATION_KEY, "complete");
  storage.setItem(REPAIR_MARKER_KEY, "complete");
  storage.setItem("unrelated", "keep");
  const loaded = loadProject(storage);
  assert.equal(storage.getItem(SIMPLIFY_BACKUP_KEY), serialized);
  assert.equal(storage.getItem(SIMPLIFY_MARKER_KEY), "complete");
  assert.equal(storage.getItem("unrelated"), "keep");
  assert.ok(named(board(loaded.project, "主流程"), "用户自定义入口"));
  const edited = structuredClone(loaded.project);
  named(board(edited, "主流程"), "Web 对话").title = "后续修改";
  storage.setItem(PROJECT_KEY, JSON.stringify(edited));
  assert.deepEqual(loadProject(storage).project, edited);
  assert.equal(storage.getItem(SIMPLIFY_BACKUP_KEY), serialized);
});

test("backup failure leaves the current design untouched", () => {
  const storage = new Storage(), original = JSON.stringify(priorProject());
  storage.setItem(PROJECT_KEY, original);
  storage.setItem(MIGRATION_KEY, "complete");
  storage.setItem(REPAIR_MARKER_KEY, "complete");
  storage.fail = key => key === SIMPLIFY_BACKUP_KEY;
  assert.throws(() => loadProject(storage));
  assert.equal(storage.getItem(PROJECT_KEY), original);
  assert.equal(storage.getItem(SIMPLIFY_MARKER_KEY), null);
});
