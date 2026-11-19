import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProject, newNode, parseProject } from "../apps/web/dist/flow-project.js";
import { layoutNode } from "../apps/web/dist/flow-project-geometry.js";
import { repairProject } from "../apps/web/dist/flow-project-repair.js";
import { loadProject, MIGRATION_KEY, PROJECT_KEY, REPAIR_BACKUP_KEY, REPAIR_MARKER_KEY } from "../apps/web/dist/flow-project-migration.js";
import { oldRelationsProject } from "./flow-project-repair-fixture.mjs";

class Storage {
  values = new Map();
  fail;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.fail?.(key, value)) throw Error("storage failure");
    this.values.set(key, String(value));
  }
}

const board = (project, name) => project.boards.find(item => item.name === name);
const named = (board, name) => board.nodes.find(item => item.title === name);
const hasEdge = (board, from, to, semantic) => board.edges.some(edge =>
  edge.fromNodeId === named(board, from)?.id && edge.toNodeId === named(board, to)?.id
  && (!semantic || edge.semantic === semantic));

test("default project connects assistance, platform boundaries and active tools", () => {
  const project = exampleProject();
  const sandbox = board(project, "沙盒执行"), qq = board(project, "QQ 星核");
  for (const [from, to, semantic] of [
    ["沙盒 Tool", "执行参数", "data"], ["执行参数", "审批辅助模型", "optional"],
    ["审批辅助模型", "Core 权限与审批", "optional"],
    ["Core 权限与审批", "Debian Shell", "trigger"],
  ]) assert.ok(hasEdge(sandbox, from, to, semantic), `${from} → ${to}`);
  for (const [from, to, semantic] of [
    ["输入过滤", "输出：QQ 上下文", "data"],
    ["输入：主流程回复", "QQ 消息发送", "trigger"],
    ["Core 工具调用", "QQ msg Tool", "trigger"],
    ["QQ msg Tool", "QQ 消息发送", "optional"],
  ]) assert.ok(hasEdge(qq, from, to, semantic), `${from} → ${to}`);
  assert.equal(repairProject(project).changed, false);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
});

test("targeted repair preserves existing cards, positions, viewport, unrelated edges and custom projects", () => {
  const original = oldRelationsProject();
  const qq = board(original, "QQ 星核");
  const custom = newNode("用户卡片", 123, -400);
  qq.nodes.push(custom);
  qq.viewport = { x: 77, y: -41, scale: .8 };
  named(qq, "QQ 上下文来源").position = { x: 700, y: 90 };
  const oldCards = structuredClone(qq.nodes);
  const oldEdges = structuredClone(qq.edges.filter(edge => edge.id !== "4c2e1646-004e-4d4e-b6cd-0c1e7451cc07"));
  const repaired = repairProject(original);
  assert.equal(repaired.changed, true);
  assert.deepEqual(board(original, "QQ 星核").nodes, oldCards);
  const result = board(repaired.project, "QQ 星核");
  for (const existing of oldCards) {
    const after = result.nodes.find(node => node.id === existing.id);
    assert.deepEqual(after.position, existing.position);
    assert.equal(after.title, existing.title);
    assert.equal(after.subtitle, existing.subtitle);
  }
  assert.deepEqual(result.viewport, qq.viewport);
  for (const existing of oldEdges) assert.deepEqual(result.edges.find(edge => edge.id === existing.id), existing);
  const originalIds = new Set(oldCards.map(item => item.id));
  for (const added of result.nodes.filter(item => !originalIds.has(item.id))) {
    const rect = layoutNode(added).bounds;
    for (const other of result.nodes.filter(item => item.id !== added.id)) {
      const box = layoutNode(other).bounds;
      assert.ok(rect.right <= box.left || rect.left >= box.right || rect.bottom <= box.top || rect.top >= box.bottom,
        `${added.title} 与 ${other.title} 重叠`);
    }
  }
  assert.equal(repairProject(repaired.project).changed, false);
  const unrelated = structuredClone(original);
  unrelated.projectId = "another-project";
  assert.equal(repairProject(unrelated).changed, false);
  assert.deepEqual(repairProject(unrelated).project, unrelated);
});

test("the existing design is backed up before one-time repair and later edits survive refresh", () => {
  const storage = new Storage();
  const original = JSON.stringify(oldRelationsProject());
  storage.setItem(PROJECT_KEY, original);
  storage.setItem(MIGRATION_KEY, "complete");
  storage.setItem("unrelated", "keep");
  const loaded = loadProject(storage);
  assert.equal(loaded.migrated, true);
  assert.equal(storage.getItem(REPAIR_BACKUP_KEY), original);
  assert.equal(storage.getItem(REPAIR_MARKER_KEY), "complete");
  assert.equal(storage.getItem("unrelated"), "keep");
  loaded.project.boards[0].nodes[0].title = "后续编辑";
  const edited = JSON.stringify(loaded.project);
  storage.setItem(PROJECT_KEY, edited);
  assert.equal(loadProject(storage).serialized, edited);
  assert.equal(storage.getItem(REPAIR_BACKUP_KEY), original);
});

test("repair failures and conflicting backups preserve the current design", () => {
  for (const failedKey of [REPAIR_BACKUP_KEY, REPAIR_MARKER_KEY, PROJECT_KEY]) {
    const storage = new Storage(), original = JSON.stringify(oldRelationsProject());
    storage.setItem(PROJECT_KEY, original);
    storage.setItem(MIGRATION_KEY, "complete");
    storage.fail = key => key === failedKey;
    assert.throws(() => loadProject(storage));
    assert.equal(storage.getItem(PROJECT_KEY), original);
  }
  const storage = new Storage(), original = JSON.stringify(oldRelationsProject());
  storage.setItem(PROJECT_KEY, original);
  storage.setItem(MIGRATION_KEY, "complete");
  storage.setItem(REPAIR_BACKUP_KEY, "other backup");
  assert.throws(() => loadProject(storage));
  assert.equal(storage.getItem(PROJECT_KEY), original);
  assert.equal(storage.getItem(REPAIR_BACKUP_KEY), "other backup");
});

test("an interrupted repair can resume after a failed completion marker", () => {
  const storage = new Storage(), original = JSON.stringify(oldRelationsProject());
  storage.setItem(PROJECT_KEY, original);
  storage.setItem(MIGRATION_KEY, "complete");
  storage.fail = (key, value) => key === REPAIR_MARKER_KEY && value === "complete";
  assert.throws(() => loadProject(storage));
  assert.equal(storage.getItem(PROJECT_KEY), original);
  assert.equal(storage.getItem(REPAIR_BACKUP_KEY), original);
  storage.fail = undefined;
  assert.ok(hasEdge(board(loadProject(storage).project, "沙盒执行"), "执行参数", "审批辅助模型"));
});
