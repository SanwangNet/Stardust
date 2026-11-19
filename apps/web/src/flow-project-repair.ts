import { connect, newId, parseProject, type Board, type DesignNode, type EdgeSemantic, type FlowDesignProject, type Port, type PortSide } from "./flow-project.js";

const ORIGINAL_PROJECT_ID = "db13a1cb-8d62-4429-9214-0a2802a2ac8a";
const SANDBOX_BOARD_ID = "37da47c7-4f12-47c1-b2bc-f674cff425b3";

/**
 * Add missing design relations to the supplied M5-C0 project.
 * Existing nodes, connections and viewports remain user-owned.
 */
export function repairProject(value: FlowDesignProject): { project: FlowDesignProject; changed: boolean } {
  const project = parseProject(value);
  if (project.projectId !== ORIGINAL_PROJECT_ID) return { project, changed: false };
  let changed = false;

  function find(board: Board, id: string): DesignNode | undefined {
    return board.nodes.find(node => node.id === id);
  }
  function port(node: DesignNode, kind: "input" | "output", side: PortSide): Port {
    const ports = kind === "input" ? node.inputPorts : node.outputPorts;
    const existing = ports.find(item => (item.side ?? (kind === "input" ? "left" : "right")) === side);
    if (existing) return existing;
    if (ports.length >= 16) {
      if (!ports[0]) throw new Error("无法建立画板连接。");
      return ports[0];
    }
    const added: Port = { id: newId(), name: kind === "input" ? "输入" : "输出", side };
    ports.push(added);
    return added;
  }
  function edge(board: Board, from: DesignNode, to: DesignNode, semantic: EdgeSemantic, output: PortSide, input: PortSide): void {
    if (board.edges.some(item => item.fromNodeId === from.id && item.toNodeId === to.id)) return;
    let source = port(from, "output", output);
    if (board.edges.some(item => item.fromNodeId === from.id && item.fromPortId === source.id)
      && from.outputPorts.length < 16) {
      source = { id: newId(), name: "输出", side: output };
      from.outputPorts.push(source);
    }
    const target = port(to, "input", input);
    if (!connect(board, from, source, to, target)) throw new Error("无法建立画板连接。");
    const created = board.edges.at(-1)!;
    created.semantic = semantic;
    created.appearance = {
      lineStyle: semantic === "optional" || semantic === "capability" ? "dashed" : "solid",
      pathStyle: "orthogonal",
    };
    changed = true;
  }

  const sandbox = project.boards.find(board => board.id === SANDBOX_BOARD_ID);
  if (sandbox) {
    const tool = find(sandbox, "a9604226-2a68-4a54-9504-f64badaacdba");
    const parameters = find(sandbox, "aea482ee-8f91-4854-8aef-94837a570741");
    const assistant = find(sandbox, "ba8b44ae-737e-4ffd-a45c-8744ef876205");
    if (tool && parameters && assistant) {
      edge(sandbox, tool, parameters, "data", "bottom", "top");
      edge(sandbox, parameters, assistant, "optional", "right", "left");
    }
  }

  return { project: changed ? parseProject(project) : project, changed };
}
