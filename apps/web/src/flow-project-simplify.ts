import { connect, newId, newNode, parseProject, removeNode, type Board, type DesignNode, type FlowDesignProject, type Port } from "./flow-project.js";

const PROJECT_ID = "db13a1cb-8d62-4429-9214-0a2802a2ac8a";
const QQ_BOARD_ID = "92a093d6-a325-4d0f-a263-8809bf26b370";
const CONTEXT_BOARD_ID = "0ea36c05-8e6f-4782-8110-e90b4e8f1e82";

/** Update only the original design, preserving user-added cards and connections. */
export function simplifyProject(value: FlowDesignProject): { project: FlowDesignProject; changed: boolean } {
  const project = parseProject(value);
  if (project.projectId !== PROJECT_ID) return { project, changed: false };
  let changed = false;
  const qq = project.boards.find(board => board.id === QQ_BOARD_ID);
  const context = project.boards.find(board => board.id === CONTEXT_BOARD_ID);

  function removeOriginal(board: Board, title: string, subtitle: string, permitted: string[]): boolean {
    const candidate = board.nodes.find(node => node.title === title && node.subtitle === subtitle);
    if (!candidate) return false;
    const related = board.edges.filter(edge => edge.fromNodeId === candidate.id || edge.toNodeId === candidate.id);
    const safe = related.every(edge => {
      const otherId = edge.fromNodeId === candidate.id ? edge.toNodeId : edge.fromNodeId;
      return permitted.includes(board.nodes.find(node => node.id === otherId)?.title ?? "");
    });
    if (!safe) return false;
    removeNode(board, candidate.id);
    changed = true;
    return true;
  }
  function rename(node: DesignNode | undefined, oldTitle: string, oldSubtitle: string, title: string, subtitle: string): void {
    if (node?.title !== oldTitle || node.subtitle !== oldSubtitle) return;
    node.title = title;
    node.subtitle = subtitle;
    changed = true;
  }

  if (context) {
    removeOriginal(context, "Web Global Context", "现有后台综合 · 独立机制", ["输出：模型"]);
  }
  if (qq) {
    const find = (id: string) => qq.nodes.find(node => node.id === id);
    const contextSource = find("bd9dc640-65d3-4997-a9af-b9f23991e0f2");
    const adapter = find("f27826ac-b890-408a-bbc9-58833fc33e42");
    const send = find("c74f0b74-9a26-41f8-9fc0-b4a9a1be51e6");
    const tool = find("89b8561d-0d3b-43ae-a6b5-c1ae812c3d24");

    const removedContextExit = removeOriginal(qq, "输出：主流程上下文", "概念出口 · QQ 当前消息", ["QQ 上下文来源"]);
    const removedReplyEntry = removeOriginal(qq, "输入：主流程回复", "按本轮 QQ 来源返回", ["QQ 输出适配"]);
    removeOriginal(qq, "输出：Tool 注册", "提供给 Core 的可用工具", ["QQ msg Tool"]);
    const removedActiveSend = removeOriginal(qq, "QQ 主动发送", "获批后调用 · 与本轮回复分开", ["QQ msg Tool"]);
    const sandbox = find("3e8c54f5-9853-4cc8-9764-e2efe4a82578");
    if (sandbox?.title === "沙盒能力引用" && sandbox.subtitle === "规划中 · 共享定义"
      && sandbox.childBoardId === "37da47c7-4f12-47c1-b2bc-f674cff425b3") {
      removeOriginal(qq, "输出：沙盒能力", "规划中 · 提供给 Tool", ["沙盒能力引用"]);
      removeOriginal(qq, "沙盒能力引用", "规划中 · 共享定义", []);
    }
    removeOriginal(qq, "<NO_REPLY> 规则", "示例规划 · 当前未实现", ["QQ msg Skill / 规则", "QQ 输出适配"]);

    if (removedContextExit || (contextSource && !qq.edges.some(edge => edge.fromNodeId === contextSource.id))) {
      rename(contextSource, "QQ 上下文来源", "当前消息 · 历史规划", "输出：QQ 上下文", "当前消息 · 提供给主流程");
    }
    if (removedReplyEntry || (adapter && !qq.edges.some(edge => edge.toNodeId === adapter.id && edge.semantic === "data"))) {
      rename(adapter, "QQ 输出适配", "文本回复 · 格式扩展规划", "输入：主流程回复", "本轮回复 · 格式适配");
    }
    const activeSendRemains = qq.nodes.some(node => node.title === "QQ 主动发送");
    if ((removedActiveSend || !activeSendRemains) && tool && send
      && !qq.edges.some(edge => edge.fromNodeId === tool.id && edge.toNodeId === send.id)) {
      let output = tool.outputPorts.find(port => port.side === "top");
      if (!output && tool.outputPorts.length < 16) {
        output = { id: newId(), name: "主动发送", side: "top" };
        tool.outputPorts.push(output);
      }
      output ??= tool.outputPorts[0];
      let input: Port | undefined = send.inputPorts.find(port => port.side === "bottom");
      if (!input && send.inputPorts.length < 16) {
        input = { id: newId(), name: "主动发送", side: "bottom" };
        send.inputPorts.push(input);
      }
      input ??= send.inputPorts[0];
      if (!output || !input || !connect(qq, tool, output, send, input)) {
        throw new Error("无法连接 QQ 主动发送。");
      }
      const created = qq.edges.at(-1)!;
      if (created.fromNodeId === tool.id && created.toNodeId === send.id) {
        created.semantic = "optional";
        created.appearance = { lineStyle: "dashed", pathStyle: "orthogonal" };
      }
      rename(send, "QQ 消息发送", "原消息目标 · 被动回复", "QQ 消息发送", "原路回复 / 已审批的主动发送");
      changed = true;
    }
    if (tool && !qq.nodes.some(node => node.title === "Core 工具调用")
      && !qq.edges.some(edge => edge.toNodeId === tool.id)) {
      const callerY = tool.position.x === 300 && tool.position.y === 340 ? 520 : tool.position.y;
      const caller = newNode("Core 工具调用", Math.max(-99000, tool.position.x - 300), callerY);
      caller.subtitle = "按需调用 · 需要审批";
      caller.visualStyle = "input";
      qq.nodes.push(caller);
      const input = tool.inputPorts[0];
      if (!input || !connect(qq, caller, caller.outputPorts[0]!, tool, input)) throw new Error("无法连接 Core 工具调用。");
      changed = true;
    }

    const positions: [string, number, number, number, number][] = [
      ["48f62129-8b3a-434e-914f-9d0b68623905", 0, 80, 0, 0],
      ["7e6dbc28-3d30-4e58-ae52-55b21ebcb8d7", 300, 80, 300, 0],
      ["bd9dc640-65d3-4997-a9af-b9f23991e0f2", 600, 80, 600, 0],
      ["f27826ac-b890-408a-bbc9-58833fc33e42", 900, 80, 0, 260],
      ["c74f0b74-9a26-41f8-9fc0-b4a9a1be51e6", 1200, 80, 600, 260],
      ["89b8561d-0d3b-43ae-a6b5-c1ae812c3d24", 300, 340, 300, 520],
      ["067b1364-819a-49f2-8cc2-11d43c53b1be", 600, 340, 0, -260],
    ];
    for (const [id, oldX, oldY, x, y] of positions) {
      const item = find(id);
      if (item?.position.x === oldX && item.position.y === oldY) {
        item.position = { x, y };
        changed = true;
      }
    }
    const caller = qq.nodes.find(node => node.title === "Core 工具调用" && node.subtitle === "Web 可用时 · Core 审批");
    if (caller?.position.x === 0 && caller.position.y === 340) {
      caller.position = { x: 0, y: 520 };
      changed = true;
    }
  }
  return { project: changed ? parseProject(project) : project, changed };
}
