import type { ExecutableFlow } from "./executable-flow.js";

type FlowCatalogEntry = { owner: string; status: string; runtime: string; requestChain?: boolean; flowSwitch?: boolean; contract?: { groups: { id: string; flow: ExecutableFlow }[] } | null };
type OverviewInput = {
  publishedId: string; webAvailable: boolean; toolSupported: boolean; historyToolSupported: boolean; modelConfigured: boolean | null;
  contextSwitch: boolean; toolSwitch: boolean; executionSwitch: boolean; skillSwitch: boolean;
  contextPublished: boolean; toolsPublished: boolean;
  graphs: { context: ExecutableFlow; tools: ExecutableFlow; execution: ExecutableFlow; skill: ExecutableFlow };
  catalog: FlowCatalogEntry[]; availableSkills: number; registeredSkills: number; tools: string[];
};

/** A read-only composition of existing paths, not an executable graph or a publication format. */
export function buildFlowOverview(input: OverviewInput) {
  const { graphs, publishedId, webAvailable, toolSupported } = input;
  const childGraph = (flow: ExecutableFlow, groupNode: string): string | null => {
    const root = flow.graphs.find(graph => graph.id === flow.rootId), node = root?.nodes.find(item => item.id === groupNode && item.type === "group");
    return node?.graphId && flow.graphs.some(graph => graph.id === node.graphId) ? node.graphId : null;
  };
  const detail = { context: childGraph(graphs.context, "context"), availability: childGraph(graphs.tools, "tools"), execution: childGraph(graphs.execution, "tool"), skill: childGraph(graphs.skill, "stages") };
  const qq = input.catalog.find(entry => entry.owner === "qq-bot"), web = input.catalog.find(entry => entry.owner === "web-chat");
  const qqGroup = qq?.contract?.groups.find(group => group.id === "qq-bot:input");
  const webGroup = web?.contract?.groups.find(group => group.id === "web-chat:web");
  const enabled = (flag: boolean) => !webAvailable ? "Web 星核不可用" : flag ? "图开关开启 · 接入 Web 请求" : "图开关关闭 · 使用原路径";
  const toolEnabled = input.toolSwitch || input.executionSwitch;
  const toolStatus = (flag: boolean) => !webAvailable ? "Web 星核不可用" : !toolSupported ? "模型不支持 Tool · 图不可用" : flag ? "图开关开启 · 按请求使用" : "图开关关闭 · 使用原路径";
  const qqStatus = !qq ? "未注册 QQ 星核" : qq.status === "uninstalled" ? "QQ 未安装" : qq.status === "disabled" ? "QQ 已停用" : qq.status !== "enabled" ? "QQ 契约不兼容" : qq.runtime !== "connected" ? "QQ 未连接" : qq.requestChain ? "QQ 入站图已接入" : "QQ 入站图开关关闭 · 使用原路径";
  const webStatus = !web ? webAvailable ? "Web 入口可用 · 星核未注册" : "Web 星核未注册" : !webAvailable ? "Web 星核不可用" : web.status === "enabled" ? "Web 星核已启用" : "Web 入口可用 · 星核声明不可用";
  const nodes = [
    { id: "web-channel", title: "Web 对话", subtitle: "Web 请求入口", state: webStatus, description: "Web HTTP 请求进入当前会话；星核声明视图包含 Web 上下文组。", kind: "channel", x: 40, y: 40, ...(webGroup ? { next: `catalog/web-chat/${webGroup.id}/${webGroup.flow.rootId}` } : {}) },
    { id: "context", title: "上下文", subtitle: "Web 会话与摘要", state: enabled(input.contextSwitch), description: "Web 组装近期会话和当前消息，并在支持历史 Tool 时按条件读取摘要；后台摘要更新是独立任务。QQ 尚未接入此会话上下文。", kind: "group", x: 330, y: 40, next: "context" },
    { id: "skills", title: "Skill", subtitle: "Web 请求准备", state: `${enabled(input.skillSwitch)} · ${input.availableSkills ? `${input.availableSkills} 个可用` : "无可加载 Skill"}`, description: `已声明 ${input.registeredSkills} 个 Skill；可用不代表本轮已选中或注入。`, kind: "group", x: 620, y: 40, next: "skill" },
    { id: "tools", title: "Tool 可用性", subtitle: "Web 模型请求准备", state: toolStatus(toolEnabled), description: `已连接扩展 Tool 候选：${input.tools.length ? input.tools.join("、") : "无"}；search_history 与候选仍受当前连接和 Core 权限限制。`, kind: "group", x: 910, y: 40, next: "tools" },
    { id: "web-model", title: "Web 模型请求", subtitle: toolSupported ? "单一主 Agent · 模型服务" : "Web 既有模型路径", state: !webAvailable ? "Web 星核不可用" : input.modelConfigured === false ? "模型尚未配置" : toolSupported ? "可选 Tool Calling" : "当前模型接口不支持 Tool", description: "使用现有模型服务；模型可返回回复或发起 Tool Call。连接和推理结果不由此状态验证。", kind: "model", x: 1200, y: 40 },
    { id: "web-output", title: "Web 回复", subtitle: "返回当前会话", state: "现有响应链", kind: "output", x: 1200, y: 245 },
    { id: "memory", title: "Global Context", subtitle: "摘要读取 / 后台综合", state: !webAvailable ? "Web 不可用 · 后台独立" : input.historyToolSupported ? "按条件读取；后台独立" : "当前模型路径不读取摘要", description: "支持历史 Tool 的 Web 请求按条件读取摘要；已完成对话可登记后台综合，非每轮同步等待。", kind: "note", x: 330, y: 245 },
    { id: "agent", title: "主 Agent 设置", subtitle: "Web 与 QQ 共享主体", state: "Core 身份与提示词", description: "Web 和 QQ 共用主 Agent 配置；渠道上下文和请求链尚未统一。", kind: "note", x: 40, y: 245 },
    { id: "tool-call", title: "Tool 调用与审批", subtitle: "仅模型发起调用时", state: toolStatus(input.executionSwitch), description: "验证、权限与审批仍由 Core 执行；Tool Result 返回模型，模型可不调用或多次调用。", kind: "group", x: 910, y: 245, next: "execution" },
    { id: "qq-channel", title: "QQ 消息", subtitle: "QQ 星核入口", state: qqStatus, description: "接收 QQ 私聊和群聊消息；不使用 Web Conversation 或 Web Skill 图。", kind: "channel", x: 40, y: 450 },
    { id: "qq-input", title: "QQ 入站处理", subtitle: "过滤与可选诊断", state: qqStatus, description: "QQ 入站图与旧路径共享原有过滤规则；图开关在星核启动时读取。", kind: "group", x: 330, y: 450, ...(qqGroup ? { next: `catalog/qq-bot/${qqGroup.id}/${qqGroup.flow.rootId}` } : {}) },
    { id: "qq-model", title: "QQ 模型请求", subtitle: "当前消息与主 Agent", state: !qq || qq.status !== "enabled" || qq.runtime !== "connected" ? qqStatus : input.modelConfigured === false ? "模型尚未配置" : "QQ 现有模型链", description: "QQ 当前消息经主 Agent 的渠道提示词调用模型；未接入 Web 上下文、Skill 与 Tool 循环。", kind: "model", x: 910, y: 450 },
    { id: "qq-output", title: "QQ 回复", subtitle: "返回原 QQ 会话", state: !qq || qq.status !== "enabled" || qq.runtime !== "connected" ? qqStatus : "QQ 现有发送链", kind: "output", x: 1200, y: 450 },
    { id: "starcores", title: "星核流程目录", subtitle: "注册与声明", state: "只读目录", description: "查看各星核声明、可信绑定及启停状态。", kind: "group", x: 620, y: 245, next: "starcores" },
  ];
  const edges = [
    { from: "web-channel", to: "context", label: "Web 会话请求", relation: "sequence" }, { from: "context", to: "skills", label: "Web 上下文", relation: "sequence" },
    { from: "skills", to: "tools", label: "模型请求准备", relation: "sequence" }, { from: "tools", to: "web-model", label: "提供可用 Tool", relation: "data" }, { from: "web-model", to: "web-output", label: "最终回复", relation: "conditional" },
    { from: "web-model", to: "tool-call", label: "模型按需调用", relation: "conditional" }, { from: "tool-call", to: "web-model", label: "Tool Result 返回模型", relation: "conditional" },
    { from: "memory", to: "context", label: "按条件读取摘要", relation: "data" },
    { from: "qq-channel", to: "qq-input", label: "QQ 入站事件", relation: "sequence" }, { from: "qq-input", to: "qq-model", label: "过滤通过", relation: "conditional" }, { from: "qq-model", to: "qq-output", label: "QQ 回复", relation: "sequence" },
  ];
  return { kind: "composite-readonly", description: "当前配置的模块关系；不是统一执行图，也不是实时运行轨迹。", publishedId, publishedInUse: webAvailable && ((input.contextSwitch && input.contextPublished) || (toolSupported && toolEnabled && input.toolsPublished)),
    references: { context: graphs.context.rootId, availability: graphs.tools.rootId, execution: graphs.execution.rootId, skill: graphs.skill.rootId, qq: qqGroup?.flow.rootId ?? null, detail },
    states: { webAvailable, contextSwitch: input.contextSwitch, toolSwitch: toolEnabled, executionSwitch: input.executionSwitch, skillSwitch: input.skillSwitch, toolSupported, historyToolSupported: input.historyToolSupported, modelConfigured: input.modelConfigured, availableSkills: input.availableSkills, registeredSkills: input.registeredSkills, qq: qqStatus }, nodes, edges };
}
