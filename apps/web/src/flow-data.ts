export type FlowViewId = "web" | "qq";
export type FlowKind = "input" | "context" | "prompt" | "agent" | "model" | "tool" | "output";
export type FlowPort = "left" | "right" | "top" | "bottom";
export type FlowNode = {
  id: string; kind: FlowKind; title: string; subtitle: string; description: string; owner: string; state: string;
  position: { x: number; y: number }; views: FlowViewId[]; childGraphId?: string; planned?: boolean; registryId?: string;
  positionByView?: Partial<Record<FlowViewId, { x: number; y: number }>>;
  descriptionByView?: Partial<Record<FlowViewId, string>>; stateByView?: Partial<Record<FlowViewId, string>>;
};
export type FlowEdge = { id: string; source: string; target: string; relation: string; views: FlowViewId[]; style?: "dependency" | "planned"; sourcePort?: FlowPort; targetPort?: FlowPort };
export type FlowGraph = { id: string; title: string; summary: string; parentId?: string; nodes: FlowNode[]; edges: FlowEdge[]; availableViews?: FlowViewId[] };
export type FlowView = { id: FlowViewId; label: string; note: string };

/** Keep planned nodes visible in their own graph, but never show another channel's path. */
export function visibleFlowGraph(graph: FlowGraph, view: FlowViewId): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = graph.nodes.filter((node) => node.planned || node.views.includes(view));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => (edge.style === "planned" || edge.views.includes(view)) && ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges };
}

export const flowViews: FlowView[] = [
  { id: "web", label: "Web 对话", note: "Web 使用会话上下文，Tool 由模型按需调用。" },
  { id: "qq", label: "QQ 机器人", note: "QQ 当前使用共同提示词和当前消息，尚未接入会话历史、全局上下文或 Tool 循环。" },
];
const both: FlowViewId[] = ["web", "qq"];
const web: FlowViewId[] = ["web"];
const qq: FlowViewId[] = ["qq"];
const planned: FlowViewId[] = [];

/** A diagram of verified paths, never an executable workflow. */
export const flowGraphs: FlowGraph[] = [
  { id:"overview", title:"总览", summary:"星尘接收消息、准备上下文并调用模型；Web 模型可按需使用 Tool，最终回复返回来源渠道。", nodes:[
    {id:"input",kind:"input",title:"输入",subtitle:"INPUT",description:"接收当前渠道的消息，交给共同的星尘主体处理。",owner:"Channel / Stardust Core",state:"渠道入口",position:{x:40,y:200},views:both,childGraphId:"input"},
    {id:"context",kind:"context",title:"上下文",subtitle:"CONTEXT",description:"Web 组装当前消息、近期会话和相关全局摘要；QQ 当前只使用本次消息。",owner:"Stardust Core",state:"按渠道准备",position:{x:350,y:200},views:both,childGraphId:"context"},
    {id:"model",kind:"model",title:"模型",subtitle:"MODEL",description:"使用共同主 Agent 提示词和适用的渠道说明生成回复。",owner:"Stardust Core",state:"模型推理",position:{x:660,y:200},views:both,childGraphId:"model"},
    {id:"tool",kind:"tool",title:"Tool",subtitle:"OPTIONAL TOOL",description:"Web 模型按需调用已授权工具，结果返回模型继续推理。",owner:"Stardust Core",state:"按需调用 · Web",position:{x:660,y:440},views:web,childGraphId:"tool"},
    {id:"output",kind:"output",title:"输出",subtitle:"OUTPUT",description:"最终回复返回原消息所在的渠道，而不是广播到所有渠道。",owner:"Channel / Stardust Core",state:"回复来源渠道",position:{x:970,y:200},views:both,childGraphId:"output"},
  ],edges:[
    {id:"overview-input-context",source:"input",target:"context",relation:"接收消息",views:both},
    {id:"overview-context-model",source:"context",target:"model",relation:"准备模型输入",views:both},
    {id:"overview-model-output",source:"model",target:"output",relation:"生成最终回复",views:both},
    {id:"overview-model-tool",source:"model",target:"tool",relation:"按需调用",views:web,style:"dependency",sourcePort:"bottom",targetPort:"top"},
    {id:"overview-tool-model",source:"tool",target:"model",relation:"结果返回模型",views:web,style:"dependency",sourcePort:"right",targetPort:"right"},
  ]},
  { id:"input", parentId:"overview", title:"输入", summary:"消息由各渠道接收并交给共同的 Agent 入口；各渠道的访问范围保持独立。", nodes:[
    {id:"web-input",kind:"input",title:"Web 对话",subtitle:"WEB CHAT",description:"Web 对话消息提交给 Core 的会话处理。",owner:"Web 对话星核 · web-chat",state:"渠道注册信息",registryId:"web-chat",position:{x:40,y:220},views:web},
    {id:"qq-input",kind:"input",title:"QQ 机器人",subtitle:"QQ BOT",description:"QQ 接收符合条件的消息，转交共同主 Agent；当前为单轮回复。",owner:"QQ 星核 · qq-bot",state:"渠道注册信息",registryId:"qq-bot",position:{x:40,y:220},views:qq},
    {id:"channel-entry",kind:"agent",title:"共同 Agent 入口",subtitle:"STARDUST",description:"不同渠道共用同一主体身份，渠道来源和访问范围独立。",owner:"Stardust Core",state:"共同主体",position:{x:420,y:220},views:both},
  ],edges:[
    {id:"web-to-agent",source:"web-input",target:"channel-entry",relation:"Web 消息",views:web},
    {id:"qq-to-agent",source:"qq-input",target:"channel-entry",relation:"QQ 消息",views:qq},
  ]},
  { id:"context", parentId:"overview", title:"上下文", summary:"Web 将当前消息、近期对话和相关摘要组装为模型输入，并在对话完成后后台更新摘要；QQ 当前仅使用本次消息。", nodes:[
    {id:"current",kind:"input",title:"当前消息 / 会话",subtitle:"CURRENT MESSAGE",description:"Web 消息进入持久化会话；QQ 当前仅传入本次消息。",owner:"Conversation / Channel",state:"按渠道处理",position:{x:40,y:200},views:both,descriptionByView:{qq:"QQ 仅传入本次消息，不读取统一会话、近期消息或全局摘要。"},stateByView:{qq:"当前消息 · 单轮"}},
    {id:"recent",kind:"context",title:"近期上下文",subtitle:"RECENT CONTEXT",description:"Web 默认选取最近 50 条已完成消息，并按完整用户 / 助手轮次裁剪；与当前消息一起受请求字节预算约束。",owner:"Conversation Core",state:"自动选取 · Web",position:{x:350,y:60},views:web},
    {id:"global",kind:"context",title:"全局上下文",subtitle:"GLOBAL CONTEXT",description:"Web 默认按相关性选择摘要作为不可信背景，排除与近期消息重叠的来源；摘要注入受预算约束。",owner:"Stardust Core",state:"相关摘要 · Web",position:{x:350,y:325},views:web},
    {id:"assembler",kind:"context",title:"上下文组装器",subtitle:"ASSEMBLER",description:"Web 组合近期完整轮次和相关摘要，优先保留当前消息；默认整体 36,000 UTF-8 字节、摘要最多 6,000 字节，不是精确 Token。",owner:"Stardust Core",state:"组装与预算 · Web",position:{x:690,y:200},views:web},
    {id:"context-output",kind:"output",title:"上下文输出",subtitle:"MODEL INPUT",description:"Web 输出受预算控制的模型消息；QQ 输出当前消息及共同提示词，不含历史摘要。",owner:"Stardust Core",state:"提交模型",position:{x:1030,y:200},positionByView:{qq:{x:420,y:200}},views:both},
    {id:"completed-turn",kind:"context",title:"成功对话",subtitle:"COMPLETED TURN",description:"Web 轮次成功且回复持久化后，登记后台综合任务。",owner:"Conversation Core",state:"Web 完成轮次",position:{x:40,y:610},views:web},
    {id:"synthesis",kind:"context",title:"后台综合",subtitle:"SYNTHESIS WORKER",description:"异步调用模型增量综合已完成的 Web 交流，不阻塞当轮回复；失败不覆盖有效摘要。",owner:"Global Context",state:"后台任务 · Web",position:{x:350,y:610},views:web},
  ],edges:[
    {id:"current-recent",source:"current",target:"recent",relation:"读取 Web 近期记录",views:web},
    {id:"current-assembler",source:"current",target:"assembler",relation:"本次用户消息",views:web},
    {id:"recent-assembler",source:"recent",target:"assembler",relation:"完整近期轮次",views:web,style:"dependency"},
    {id:"global-assembler",source:"global",target:"assembler",relation:"相关摘要",views:web,style:"dependency"},
    {id:"assembler-output",source:"assembler",target:"context-output",relation:"Web 模型上下文",views:web},
    {id:"qq-current-output",source:"current",target:"context-output",relation:"QQ 仅当前消息；共同提示词在模型子图组装",views:["qq"]},
    {id:"turn-synthesis",source:"completed-turn",target:"synthesis",relation:"登记后台综合",views:web,style:"dependency"},
    {id:"synthesis-global",source:"synthesis",target:"global",relation:"增量更新摘要",views:web,style:"dependency",sourcePort:"top",targetPort:"bottom"},
  ]},
  { id:"model", parentId:"overview", title:"模型", summary:"共同主体提示词与适用的渠道说明共同组成模型提示词，再由模型服务生成回复。Skill 目前尚未接入。", nodes:[
    {id:"agent-prompt",kind:"prompt",title:"主 Agent 提示词",subtitle:"AGENT PROMPT",description:"由 Core 管理、可编辑并持久化的共同主体提示词，Web 与 QQ 共用。",owner:"Agent Core",state:"可配置",position:{x:40,y:60},positionByView:{qq:{x:40,y:190}},views:both},
    {id:"channel-prompt",kind:"prompt",title:"Web 渠道提示词",subtitle:"CHANNEL PROMPT",description:"Web 星核提供的可编辑补充说明，QQ 当前不使用它。",owner:"Web 对话星核",state:"可配置 · Web",position:{x:40,y:270},views:web},
    {id:"skill",kind:"prompt",title:"Skill",subtitle:"SKILL",description:"星核可声明 Skill 描述；目前没有 Skill Runtime 或注入机制，也不能授予工具权限。",owner:"星核 · 未来接入",state:"尚未接入",position:{x:40,y:480},views:planned,planned:true},
    {id:"prompt",kind:"prompt",title:"提示词组装",subtitle:"PROMPT ASSEMBLY",description:"组合固定安全约束与共同主体提示词；Web 另含渠道补充和相关上下文。",owner:"Agent Core",state:"已实现",position:{x:390,y:190},views:both},
    {id:"model-service",kind:"model",title:"模型推理",subtitle:"MODEL SERVICE",description:"使用配置的模型调用 Chat Completions。Web 支持可选工具调用；QQ 当前直接生成回复。",owner:"Stardust Core",state:"模型服务配置",position:{x:750,y:190},views:both},
  ],edges:[
    {id:"agent-prompt-assembly",source:"agent-prompt",target:"prompt",relation:"共同主体提示词",views:both,style:"dependency"},
    {id:"channel-prompt-assembly",source:"channel-prompt",target:"prompt",relation:"Web 渠道说明",views:web,style:"dependency"},
    {id:"skill-planned",source:"skill",target:"prompt",relation:"尚未接入",views:planned,style:"planned"},
    {id:"prompt-model",source:"prompt",target:"model-service",relation:"调用模型",views:both},
  ]},
  { id:"tool", parentId:"overview", title:"Tool", summary:"Web 模型按需发起工具调用，经过可用性与权限检查后执行或拒绝，并将结果返回模型。", availableViews:["web"], nodes:[
    {id:"tool-request",kind:"model",title:"模型请求调用",subtitle:"OPTIONAL TOOL",description:"仅当 Web 模型发起工具调用时进入该子流程。",owner:"ModelService",state:"按需 · Web",position:{x:20,y:220},views:web},
    {id:"tool-policy",kind:"tool",title:"可用性与权限",subtitle:"POLICY",description:"Core 检查 Tool 已注册、可用及 Web 渠道配置；未授权工具不会执行。",owner:"Tool Run / Core",state:"权限检查",position:{x:320,y:220},views:web},
    {id:"history",kind:"tool",title:"历史检索",subtitle:"SEARCH HISTORY",description:"模型按需调用的内部只读 Tool，检索当前 Web 作用域原始历史；不是每轮自动运行。",owner:"Core · 内部 Tool",state:"只读 · Web",position:{x:620,y:35},views:web},
    {id:"approval",kind:"tool",title:"等待确认",subtitle:"APPROVAL",description:"具有外部副作用的操作按现有策略请求用户确认。",owner:"Stardust Core",state:"外部操作",position:{x:620,y:245},views:web},
    {id:"denied",kind:"tool",title:"不可用 / 拒绝",subtitle:"DENIED",description:"未注册、停用、无权限或被用户拒绝的调用不会执行，结果反馈模型。",owner:"Stardust Core",state:"不会执行",position:{x:620,y:455},views:web},
    {id:"executor",kind:"tool",title:"Tool 执行",subtitle:"EXECUTOR",description:"确认后由 Core 调用已启用的外部工具；不重放历史调用。",owner:"Core / 已启用星核",state:"经权限检查",position:{x:930,y:245},views:web},
    {id:"tool-result",kind:"model",title:"结果返回模型",subtitle:"TOOL RESULT",description:"只读结果、外部执行结果或拒绝状态按调用 ID 返回模型，继续推理。",owner:"Tool Run",state:"继续推理",position:{x:1250,y:220},views:web},
  ],edges:[
    {id:"request-policy",source:"tool-request",target:"tool-policy",relation:"校验调用",views:web},
    {id:"policy-history",source:"tool-policy",target:"history",relation:"只读检索",views:web},
    {id:"policy-approval",source:"tool-policy",target:"approval",relation:"外部操作需确认",views:web},
    {id:"policy-denied",source:"tool-policy",target:"denied",relation:"不可用或拒绝",views:web},
    {id:"approved-execute",source:"approval",target:"executor",relation:"确认后执行",views:web},
    {id:"history-result",source:"history",target:"tool-result",relation:"检索结果",views:web},
    {id:"executor-result",source:"executor",target:"tool-result",relation:"执行结果",views:web},
    {id:"denied-result",source:"denied",target:"tool-result",relation:"拒绝状态",views:web},
  ]},
  { id:"output", parentId:"overview", title:"输出", summary:"模型生成最终回复后，系统根据消息来源将回复返回对应的 Web 会话或 QQ 目标。", nodes:[
    {id:"final",kind:"model",title:"最终回复",subtitle:"FINAL RESPONSE",description:"模型生成最终回复；按消息来源选择对应渠道。",owner:"Stardust Core",state:"选择来源渠道",position:{x:40,y:210},views:both},
    {id:"web-output",kind:"output",title:"Web 回复",subtitle:"WEB OUTPUT",description:"最终回复持久化并返回当前 Web 会话。",owner:"Web 对话星核",state:"Web",position:{x:430,y:210},views:web},
    {id:"qq-output",kind:"output",title:"QQ 回复",subtitle:"QQ OUTPUT",description:"QQ 星核向原消息目标发送被动回复。",owner:"QQ 星核",state:"QQ",position:{x:430,y:210},views:qq},
  ],edges:[
    {id:"final-web",source:"final",target:"web-output",relation:"来源为 Web",views:web},
    {id:"final-qq",source:"final",target:"qq-output",relation:"来源为 QQ",views:qq},
  ]},
];
