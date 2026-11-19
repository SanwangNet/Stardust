import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProject, parseProject } from "../apps/web/dist/flow-project.js";

const project = exampleProject();
const board = name => project.boards.find(item => item.name === name);
const node = (item, title) => item.nodes.find(entry => entry.title === title);
const edge = (item, from, to) => item.edges.find(link =>
  link.fromNodeId === node(item, from)?.id && link.toNodeId === node(item, to)?.id);

test("default project contains the six boards from the supplied V1 project", () => {
  assert.deepEqual(project.boards.map(item => item.name), ["主流程", "上下文", "Skill", "Tool", "QQ 星核", "沙盒执行"]);
  assert.equal(project.rootBoardId, board("主流程").id);
  assert.deepEqual(parseProject(JSON.parse(JSON.stringify(project))), project);
  const ids = [
    "d68014d6-12dd-4304-92e6-e3e4bc5ad4d4", "0ea36c05-8e6f-4782-8110-e90b4e8f1e82",
    "cbc34832-7368-445a-9743-9fdc94bcb14d", "e8923e0d-e64f-4009-bac1-a0337714d606",
    "92a093d6-a325-4d0f-a263-8809bf26b370", "37da47c7-4f12-47c1-b2bc-f674cff425b3",
  ];
  assert.deepEqual(project.boards.map(item => item.id), ids);
});

test("both channels enter one agent and the direct reply bypasses optional capabilities", () => {
  const main = board("主流程");
  assert.equal(main.nodes.filter(item => item.title === "主 Agent").length, 1);
  assert.ok(!board("QQ 星核").nodes.some(item => item.title === "主 Agent" || item.title === "模型处理"));
  for (const [from, to] of [
    ["QQ 消息", "QQ 输入适配"], ["QQ 输入适配", "上下文准备"],
    ["Web 对话", "Web 输入适配"], ["Web 输入适配", "上下文准备"],
    ["上下文准备", "主 Agent"], ["主 Agent", "模型调用"],
    ["模型调用", "输出路由"], ["输出路由", "Web 回复"], ["输出路由", "QQ 回复"],
  ]) assert.ok(edge(main, from, to), `${from} → ${to}`);
  for (const capability of ["Skill 能力", "Tool 能力", "沙盒能力"]) {
    assert.ok(!edge(main, "上下文准备", capability));
    assert.ok(!edge(main, "主 Agent", capability));
  }
  assert.equal(edge(main, "Skill 能力", "模型调用").semantic, "capability");
  assert.equal(edge(main, "模型调用", "Tool Call").semantic, "optional");
  assert.ok(main.edges.some(link => link.fromNodeId === node(main, "Tool 能力").id
    && link.toNodeId === node(main, "模型调用").id && link.semantic === "feedback"));
  assert.equal(edge(main, "沙盒能力", "Tool 能力").semantic, "optional");
});

test("node group links reuse the original definitions, including a shared sandbox", () => {
  const main = board("主流程");
  for (const [title, target] of [["QQ 消息", "QQ 星核"], ["上下文准备", "上下文"],
    ["Skill 能力", "Skill"], ["Tool 能力", "Tool"], ["沙盒能力", "沙盒执行"]]) {
    assert.equal(node(main, title).childBoardId, board(target).id);
  }
  assert.equal(node(main, "沙盒能力").childBoardId, board("沙盒执行").id);
});

test("context, tools, skills and sandbox distinguish the implemented path from future ideas", () => {
  const ctx = board("上下文"), tools = board("Tool"), skills = board("Skill"), sandbox = board("沙盒执行");
  assert.ok(edge(ctx, "完整短期上下文", "输出：模型"));
  assert.equal(edge(ctx, "退出短期窗口", "上下文压缩").semantic, "optional");
  assert.match(node(ctx, "长期记忆").subtitle, /未实现/);
  assert.equal(node(ctx, "Web Global Context"), undefined);
  assert.match(node(ctx, "QQ 上下文").subtitle, /当前消息/);
  assert.match(node(skills, "选择 Skill").subtitle, /关键词/);
  assert.match(node(skills, "模型自主读取").subtitle, /未来目标/);
  assert.ok(edge(tools, "用户审批", "实际执行"));
  assert.ok(edge(tools, "实际执行", "Tool Result"));
  assert.ok(edge(tools, "拒绝 / 失败", "Tool Result"));
  assert.match(node(sandbox, "Debian Shell").subtitle, /未提供/);
  assert.match(node(sandbox, "Core 权限与审批").subtitle, /Core/);
});
