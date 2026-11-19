import { readFileSync } from "node:fs";
import { parseProject } from "../apps/web/dist/flow-project.js";

/** Recreate the original M5-C0 relations while retaining stable IDs. */
export function oldRelationsProject() {
  const project = parseProject(JSON.parse(readFileSync(new URL("./fixtures/flow-m5-c0-relations.json", import.meta.url), "utf8")));
  const qq = project.boards.find(board => board.name === "QQ 星核");
  const added = new Set(["输出：主流程上下文", "Core 工具调用", "输出：Tool 注册", "QQ 主动发送", "输出：沙盒能力", "输入：主流程回复"]);
  const removed = new Set(qq.nodes.filter(node => added.has(node.title)).map(node => node.id));
  qq.nodes = qq.nodes.filter(node => !removed.has(node.id));
  qq.edges = qq.edges.filter(edge => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId));
  const noReply = qq.edges.find(edge => edge.id === "4c2e1646-004e-4d4e-b6cd-0c1e7451cc07");
  noReply.fromPortId = "bf2a7f0f-ad03-4c27-ab83-1df563f6dd80";
  noReply.toNodeId = "f27826ac-b890-408a-bbc9-58833fc33e42";
  noReply.toPortId = "1b85c500-d2cd-44ff-85fc-0a26fe1662ea";
  const sandbox = project.boards.find(board => board.name === "沙盒执行");
  const params = sandbox.nodes.find(node => node.title === "执行参数");
  const tool = sandbox.nodes.find(node => node.title === "沙盒 Tool");
  const assistant = sandbox.nodes.find(node => node.title === "审批辅助模型");
  sandbox.edges = sandbox.edges.filter(edge => !(edge.fromNodeId === tool.id && edge.toNodeId === params.id)
    && !(edge.fromNodeId === params.id && edge.toNodeId === assistant.id));
  return project;
}
