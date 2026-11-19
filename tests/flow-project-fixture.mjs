import { connect, newBoard, newId, newNode } from "../apps/web/dist/flow-project.js";

// Small V1 fixture used by editor regression tests.
export function exampleProject() {
  const root = newBoard("主流程"), child = newBoard("上下文");
  const specs = [
    ["QQ 消息", 20, 20, "input"], ["Web 对话", 20, 200, "input"],
    ["上下文", 320, 110, "context"], ["Skill", 620, 110, "prompt"],
    ["Tool 可用性", 920, 110, "tool"], ["Tool 调用与审批", 1220, 110, "tool"],
    ["Web 回复", 1520, 20, "output"], ["QQ 回复", 1520, 200, "output"],
  ];
  root.nodes = specs.map(([title, x, y, style]) => {
    const node = newNode(title, x, y);
    node.visualStyle = style;
    return node;
  });
  root.nodes[2].childBoardId = child.id;
  for (const [a, b] of [[0, 2], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [5, 7]]) {
    connect(root, root.nodes[a], root.nodes[a].outputPorts[0], root.nodes[b], root.nodes[b].inputPorts[0]);
  }
  child.nodes = ["输入：QQ 上下文", "输入：Web 上下文", "上下文总结", "全局上下文池", "输出：模型"]
    .map((title, index) => newNode(title, index * 300, 90));
  for (const [a, b] of [[0, 2], [1, 2], [2, 3], [3, 4]]) {
    connect(child, child.nodes[a], child.nodes[a].outputPorts[0], child.nodes[b], child.nodes[b].inputPorts[0]);
  }
  return { schemaVersion: 1, projectId: newId(), projectName: "Stardust 设计工程", rootBoardId: root.id, boards: [root, child] };
}
