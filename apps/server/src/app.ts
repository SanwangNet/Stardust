import { IdentityResolver, type IdentityInput } from "./identity-resolver.js";
import { scopedPersonContext } from "./context-access-policy.js";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { AlreadyInitializedError, ConfigValidationError, validateConfigUpdate, type ConfigUpdate } from "./config.js";
import { loadCoreEnv } from "./env.js";
import { setupService, type SetupService } from "./setup.js";
import { ModelError, modelService, type ModelService } from "./model.js";
import { ExtensionError, ExtensionManager } from "./extension-manager.js";
import { logger, type LogService, type LogEntry } from "./logger.js";
import { isWebAccess, isTrustedLocalAccess, parseTrustedProxies } from "./local-access.js";
import { checkSoftwareUpdate } from "./software-update.js";
import { createWebUpdateControl } from "./web-update-control.js";
import { ToolRuns } from "./tool-runs.js";
import { ScopedHistorySearch } from "./scoped-history-search.js";
import { ContextService, deliveryStatus } from "./context-service.js";
import { PeopleObserver } from "./people-observer.js";
import { PeopleManagementReader, type ManagementQuery, type ManagementMutation } from "./people-management.js";
import { QQToolRuns, type QQToolPolicy, type QQToolStarter } from "./qq-tool-runs.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import type { ConversationService } from "./conversation.js";
import { WEB_CONTEXT_OWNER } from "./global-context.js";
import { webChatExtension } from "./extensions/web-chat.js";
import { WebContextFlowError } from "./web-context-flow.js";
import { builtInWebToolFlow, runWebToolFlow, WebToolFlowError } from "./web-tool-flow.js";
import type { ExecutableFlow } from "./executable-flow.js";
import { builtInWebToolExecutionFlow } from "./web-tool-execution-flow.js";
import { FlowPublication, resolvePublishedGraphs } from "./flow-publication.js";
import { webContextDeclaration } from "./starcore-flow.js";
import { builtInSkillFlow, runSkillFlow, SkillFlowError } from "./skill-flow.js";
import { buildFlowOverview } from "./flow-overview.js";
import { applicationRoot } from "./env.js";

// Resolve once when this process starts: changing current cannot change its identity.
export function readRunningCommit(root: string = applicationRoot): string {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(root, ".stardust-candidate.json"), "utf8"));
    if (metadata && typeof metadata === "object" && "sha" in metadata && typeof metadata.sha === "string" && /^[a-f0-9]{40}$/.test(metadata.sha) && "status" in metadata && metadata.status === "prepared") return metadata.sha;
  } catch { /* Development checkout or unavailable metadata. */ }
  return "development";
}
const runningSha = readRunningCommit();
function readRunningVersion(): string {
  try {
    const data: unknown = JSON.parse(readFileSync(join(applicationRoot, "package.json"), "utf8"));
    if (data && typeof data === "object" && "version" in data && typeof data.version === "string" && /^[0-9A-Za-z.+-]{1,80}$/.test(data.version)) return data.version;
  } catch { /* Release metadata may be unavailable in development fixtures. */ }
  return "unknown";
}

export interface AppOptions {
  version?: string;
  staticDir?: string;
  startedAt?: Date;
  setupService?: SetupService;
  modelService?: ModelService;
  extensionManager?: ExtensionManager;
  logService?: LogService;
  conversationService?: ConversationService;
  startConversations?: boolean;
  toolAvailabilityFlow?: { enabled: boolean; definition?: ExecutableFlow };
  toolExecutionFlow?: { enabled: boolean; definition?: ExecutableFlow };
  skillFlow?: { enabled: boolean; definition?: ExecutableFlow };
  flowPublication?: FlowPublication;
  agentOrchestrator?: AgentOrchestrator;
  /** Trusted server integration only; it is deliberately not wired to production QQ input. */
  qqToolAdapter?: { policy?: QQToolPolicy; register(start: QQToolStarter): void; runTimeoutMs?: number; retentionMs?: number };
  qqApprovalToken?: string;
  /** In-process test seam; never configured by browser requests. */
  webUpdateControl?: ReturnType<typeof createWebUpdateControl>;
  runningShaForTest?: string;
  updateCheckForTest?: typeof checkSoftwareUpdate;
  qqToolCalling?: { enabled: boolean; policy: QQToolPolicy; maxActive?: number };
}

const defaultStaticDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const maxSetupBody = 16 * 1024;
const maxCapabilityUploadBody = 20 * 1024 * 1024 + 64 * 1024;
const maxCapabilityImageSize = 10 * 1024 * 1024;

function readSetupBody(request: IncomingMessage, limit = maxSetupBody): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size <= limit) chunks.push(bytes);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (size > limit) return reject(new RangeError("BODY_TOO_LARGE"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch (error) { reject(error); }
    });
  });
}

function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size <= limit) chunks.push(bytes);
    });
    request.on("error", reject);
    request.on("end", () => size > limit ? reject(new RangeError("BODY_TOO_LARGE")) : resolve(Buffer.concat(chunks)));
  });
}

async function readCapabilityForm(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new TypeError("INVALID_INPUT");
  const raw = await readRawBody(request, maxCapabilityUploadBody);
  const form = await new Request("http://localhost/", { method: "POST", headers: { "Content-Type": contentType }, body: raw }).formData();
  const fields: Record<string, unknown> = {};
  const images: Buffer[] = [];
  const imageSeen = new Set<string>();
  for (const [key, value] of form.entries()) {
    if (key === "image1" || key === "image2") {
      if (imageSeen.has(key) || !(value instanceof File) || value.type.toLowerCase() !== "image/png" || !value.name.toLowerCase().endsWith(".png") || value.size < 33 || value.size > maxCapabilityImageSize) throw new TypeError("INVALID_INPUT");
      const bytes = Buffer.from(await value.arrayBuffer());
      if (bytes.length !== value.size || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) throw new TypeError("INVALID_INPUT");
      imageSeen.add(key);
      images[key === "image1" ? 0 : 1] = bytes;
    } else {
      if (typeof value !== "string" || Object.hasOwn(fields, key)) throw new TypeError("INVALID_INPUT");
      fields[key] = value;
    }
  }
  if (!images[0] || !images[1] || images[0].equals(images[1])) throw new TypeError("INVALID_INPUT");
  fields.imageFiles = [images[0], images[1]];
  return fields;
}

const staticFiles: Readonly<Record<string, { filename: string; contentType: string }>> = {
  "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
  "/navigation-transition.js": { filename: "navigation-transition.js", contentType: "text/javascript; charset=utf-8" },
  "/navigation-diagnostics.js": { filename: "navigation-diagnostics.js", contentType: "text/javascript; charset=utf-8" },
  "/model-errors.js": { filename: "model-errors.js", contentType: "text/javascript; charset=utf-8" },
  "/model-classification.js": { filename: "model-classification.js", contentType: "text/javascript; charset=utf-8" },
  "/chat-history.js": { filename: "chat-history.js", contentType: "text/javascript; charset=utf-8" },
  "/conversation-ui.js": { filename: "conversation-ui.js", contentType: "text/javascript; charset=utf-8" },
  "/approval-ui.js": { filename: "approval-ui.js", contentType: "text/javascript; charset=utf-8" },
  "/people-ui.js": { filename: "people-ui.js", contentType: "text/javascript; charset=utf-8" },
  "/global-context-ui.js": { filename: "global-context-ui.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-board.js": { filename: "flow-board.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project-board.js": { filename: "flow-project-board.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project.js": { filename: "flow-project.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-default-project.js": { filename: "flow-default-project.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project-migration.js": { filename: "flow-project-migration.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project-repair.js": { filename: "flow-project-repair.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project-simplify.js": { filename: "flow-project-simplify.js", contentType: "text/javascript; charset=utf-8" },
  "/flow-project-geometry.js": { filename: "flow-project-geometry.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { filename: "style.css", contentType: "text/css; charset=utf-8" },
  "/favicon.svg": { filename: "favicon.svg", contentType: "image/svg+xml" },
};

export function createStardustServer(options: AppOptions = {}): Server {
  const webUpdate = options.webUpdateControl ?? createWebUpdateControl(process.env.STARDUST_WEB_UPDATE_ENABLED === "1");
  const activeSha = options.runningShaForTest ?? runningSha;
  const startedAt = options.startedAt ?? new Date();
  const version = options.version ?? readRunningVersion();
  const staticDir = options.staticDir ?? defaultStaticDir;
  const setup = options.setupService ?? setupService;
  const model = options.modelService ?? modelService;
  const logs = options.logService ?? logger;
  const extensions = options.extensionManager ?? new ExtensionManager(undefined, model, [webChatExtension], logs);
  const devProxyProof = process.env.STARDUST_DEV_PROXY_PROOF;
  const trustedProxies = parseTrustedProxies(process.env.STARDUST_TRUSTED_PROXIES ?? loadCoreEnv().STARDUST_TRUSTED_PROXIES ?? "");
  const agent = options.agentOrchestrator ?? new AgentOrchestrator(model);
  const toolRuns = new ToolRuns(model, extensions, logs, agent);
  const flowPublication = options.flowPublication ?? new FlowPublication();
  const streams = new Set<ServerResponse>();
  let conversations = options.conversationService;
  let contextService: ContextService | undefined;
  let conversationOpening: Promise<ConversationService> | undefined;
  const conversationRuns = new Map<string, string>();
  const conversationOwner = (id: string) => `web:${id}`;
  const localToolOwner = "local-tool-api";
  let serverClosing = false;
  const webChannelAvailable = (): boolean => typeof extensions.channelEnabled !== "function" || !extensions.list().some((item) => item.id === "web-chat" && item.builtin) || extensions.channelEnabled("web-chat");
  function overviewData(canEdit: boolean) {
    const state = flowPublication.read();
    const skills = typeof extensions.skillSnapshot === "function" ? extensions.skillSnapshot() : [];
    const catalog = typeof extensions.flowCatalog === "function" ? extensions.flowCatalog() : [];
    const published = resolvePublishedGraphs(state.published.connections), contextConfig = conversations?.contextFlowConfiguration();
    const contextSwitch = contextConfig?.enabled ?? process.env.STARDUST_WEB_CONTEXT_FLOW === "1";
    const executionSwitch = options.toolExecutionFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_EXECUTION_FLOW === "1";
    const toolSwitch = options.toolAvailabilityFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_FLOW === "1";
    const skillSwitch = options.skillFlow?.enabled ?? process.env.STARDUST_WEB_SKILL_FLOW === "1";
    const graphs = { context: contextConfig?.definition ?? published.context, tools: options.toolAvailabilityFlow?.definition ?? published.tools, execution: options.toolExecutionFlow?.definition ?? builtInWebToolExecutionFlow(), skill: options.skillFlow?.definition ?? builtInSkillFlow(skills) };
    const connected = (flow: ExecutableFlow, graphId: string, from: string, to: string, port: string) => flow.graphs.find(graph => graph.id === graphId)?.edges.some(edge => edge.from.node === from && edge.from.port === "value" && edge.to.node === to && edge.to.port === port) ?? false;
    const childId = (flow: ExecutableFlow, nodeId: string) => flow.graphs.find(graph => graph.id === flow.rootId)?.nodes.find(node => node.id === nodeId && node.type === "group")?.graphId ?? "";
    const contextChild = childId(graphs.context, "context"), toolsChild = childId(graphs.tools, "tools");
    const currentConnections = { recent: connected(graphs.context, contextChild, "recent", "assembler", "recent"), global: connected(graphs.context, contextChild, "global", "assembler", "global"), search: connected(graphs.tools, toolsChild, "search", "filter", "search") };
    if (contextSwitch) {
      const web = catalog.find(entry => entry.owner === "web-chat");
      if (web?.contract && web.status !== "incompatible") web.contract = webContextDeclaration(web.contract.packageVersion, graphs.context);
    }
    const toolNames = typeof extensions.availableTools === "function" ? extensions.availableTools().map(tool => tool.name) : [];
    const webAvailable = webChannelAvailable(), toolSupported = typeof model.chatWithTools === "function", toolGraph = toolSwitch || executionSwitch;
    let modelConfigured: boolean | null = null;
    try { if (typeof model.getConfig === "function") { const config = model.getConfig(); modelConfigured = Boolean(config.baseUrl && config.modelId); } } catch { /* Do not expose configuration errors or secrets. */ }
    const extensionConnected = !toolGraph || connected(graphs.tools, toolsChild, "extensions", "filter", "extensions");
    const toolCandidates = ["search_history", ...toolNames.filter(name => name !== "search_history")].map(name => {
      const connectedForName = name === "search_history" ? !toolGraph || currentConnections.search : extensionConnected;
      let allowed: boolean | undefined;
      try { allowed = conversations?.agent.toolAllowed(name); } catch { /* Report unknown until a request validates settings. */ }
      const status = !webAvailable || !toolSupported ? "当前 Web 模型路径不可用" : !connectedForName ? "执行图连线已断开" : allowed === false ? "Core 已禁用" : allowed === undefined ? "权限将在请求时检查" : "当前配置可用 · 请求时复核";
      return { name, status };
    });
    const overview = buildFlowOverview({ publishedId: state.published.id, webAvailable, toolSupported, historyToolSupported: contextConfig?.historyToolSupported ?? toolSupported, modelConfigured, contextSwitch, toolSwitch, executionSwitch, skillSwitch, contextPublished: !contextConfig?.definition, toolsPublished: !options.toolAvailabilityFlow?.definition, graphs, catalog, availableSkills: skills.filter(item => item.available).length, registeredSkills: skills.length, tools: toolNames });
    return { canEdit, editableConnections: { context: !contextConfig?.definition, tools: !options.toolAvailabilityFlow?.definition }, revision: canEdit ? state.revision : undefined, draft: canEdit ? state.draft : currentConnections, currentConnections, published: state.published, graphs, catalog, overview, toolCandidates,
      skills: skills.map(item => ({ id: item.declaration.id, owner: item.declaration.owner, name: item.declaration.name, description: item.declaration.description, enabled: item.enabled, available: item.available, trusted: !!item.load, status: item.status })),
      active: { context: contextSwitch, tools: toolSwitch || executionSwitch, execution: executionSwitch, skill: skillSwitch } };
  }
  async function openConversations(): Promise<ConversationService> {
    if (!conversations) {
      conversationOpening ??= import("./conversation.js").then(({ ConversationService }) => new ConversationService(model));
      try { conversations = await conversationOpening; }
      catch (error) { conversationOpening = undefined; throw error; }
    }
    conversations.globalContext.start();
    if (!contextService) { contextService = conversations.context; contextService.setHistorySearch(scopedHistory); }
    return conversations;
  }
  const peopleObserver = new PeopleObserver(async () => (await openConversations()).databasePath, logs);
  const peopleReader = new PeopleManagementReader();
  const identityResolver = new IdentityResolver();
  const scopedHistory = new ScopedHistorySearch();
  const controlToken = randomBytes(32).toString("base64url");
  const peoplePreviewKey = randomBytes(32);
  if (typeof extensions.setChannelObserver === "function") extensions.setChannelObserver((observation, signal) => peopleObserver.submit(observation, signal));
  const approvalToken = options.qqApprovalToken ?? process.env.STARDUST_QQ_APPROVAL_TOKEN ?? "";
  const validApprovalToken = /^[A-Za-z0-9_-]{43}$/.test(approvalToken);
  const envList = (name: string) => (process.env[name] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const qqPolicy = options.qqToolCalling?.policy ?? options.qqToolAdapter?.policy ?? { private: envList("STARDUST_QQ_TOOL_PRIVATE_ALLOW"), group: envList("STARDUST_QQ_TOOL_GROUP_ALLOW"), privateSenders: envList("STARDUST_QQ_TOOL_PRIVATE_SENDERS"), groups: envList("STARDUST_QQ_TOOL_GROUPS"), groupSenders: envList("STARDUST_QQ_TOOL_GROUP_SENDERS") };
  const qqEnabled = options.qqToolCalling?.enabled ?? process.env.STARDUST_QQ_TOOL_CALLING === "1";
  const qqRuns = new QQToolRuns(toolRuns, extensions, async () => (await openConversations()).agent, qqPolicy, options.qqToolAdapter?.runTimeoutMs, options.qqToolAdapter?.retentionMs, options.qqToolCalling?.maxActive, async (context, input, signal) => scopedHistory.search((await openConversations()).databasePath, context, input, signal));
  if (typeof extensions.setChannelContextObservation === "function") extensions.setChannelContextObservation(async (message,signal) => {
    await openConversations();
    await contextService!.forQQ(message).prepare(signal);
  });
  options.qqToolAdapter?.register((message, signal) => {
    if (!validApprovalToken) throw new Error("ADMIN_NOT_CONFIGURED");
    return qqRuns.start(message, signal);
  });
  if ((options.startConversations || !options.extensionManager || options.modelService) && typeof extensions.setChannelChat === "function") {
    extensions.setChannelChat(async (message, signal, deliver) => {
      const store = await openConversations();
      const core = store.agent;
      const identityInput: IdentityInput | undefined = message.channelId === "qq-bot" && message.identityAccountId ? { channelId: "qq-bot", accountId: message.identityAccountId, senderId: message.senderId, conversationType: message.conversationType, ...(message.conversationType === "group" ? { groupId: message.conversationId } : {}) } : undefined;
      const resolution = identityInput ? await identityResolver.resolve(store.databasePath, store.people, identityInput) : undefined;
      if (resolution?.kind === "unavailable") logs.write("WARN", "people", "人物身份解析暂不可用。", { code: "IDENTITY_UNAVAILABLE" });
      const personContext = identityInput && resolution ? scopedPersonContext(identityInput, resolution) : undefined;
      let contextMessages: import("./conversation-context.js").ConversationContextMessage[] = [{ role:"user", content:message.content }];
      let handle: import("./context-service.js").StarcoreContextHandle | undefined;
      if (identityInput) {
        try { handle=contextService!.forQQ(message); const snapshot=await handle.prepare(signal); contextMessages=snapshot.messages; }
        catch { handle=undefined; logs.write("WARN", "history", "QQ 上下文不可用，使用当前消息。", { code:"CONTEXT_UNAVAILABLE" }); }
      }
      const deliverAndRecord = async (reply:string, deliverySignal:AbortSignal) => {
        const text=Array.from(reply).slice(0,1500).join("");
        const save=async(status:"pending"|"complete"|"failed"|"unknown")=>{if(!handle || !text.trim())return;try{await handle.saveReply(text,status);}catch{logs.write("WARN","history","QQ 回复状态保存未完成。",{code:"HISTORY_UNAVAILABLE"});}};
        await save("pending");
        if (!deliver) { await save("failed"); return {status:"unavailable" as const}; }
        let result: Awaited<ReturnType<typeof deliver>>;
        try {result=await deliver(reply,deliverySignal);} catch {result={status:"unknown_outcome"};}
        await save(deliveryStatus(result)); return result;
      };
      if (message.channelId === "qq-bot" && qqEnabled && typeof model.chatWithTools === "function" && deliver && qqRuns.productionAllowed(message)) {
        const runId = await qqRuns.start(message, signal, { deliver: deliverAndRecord, personContext, contextMessages, ...(handle ? {searchHistory: handle.search} : {}) });
        if (runId) return { kind: "deferred" as const };
      }
      // ExtensionManager verifies the channel against the running extension; QQ has
      // already validated the reply target and scope before calling the host.
      const conversationId = createHash("sha256").update(JSON.stringify([message.channelId, message.conversationType, message.conversationId])).digest("hex");
      const result = await agent.execute({
        source: { starcoreId: message.channelId, channelId: message.channelId, conversationId },
        current: message.content,
        messages: [{ role: "system", content: core.instructions(message.channelId) }, ...(personContext ? [personContext] : []), ...contextMessages],
        signal, modelContext: { eventId: message.eventId },
      }, { mode: "model-only" });
      if (message.channelId === "qq-bot" && deliver) { await deliverAndRecord(result.content,signal); return {kind:"deferred" as const}; }
      return result.content;
    });
  }

  const server: Server = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "INVALID_URL" });
      return;
    }
    const trusted = (requireOrigin: boolean) => isWebAccess(request, server.address(), requireOrigin, trustedProxies, devProxyProof);
    const isSameOrigin = (_request: IncomingMessage) => trusted(false);
    const adminAuthorized = () => {
      const supplied = request.headers["x-stardust-approval-token"];
      return validApprovalToken && typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(approvalToken));
    };
    const controlAuthorized = () => {
      const value = request.headers["x-stardust-control-token"];
      return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(controlToken));
    };
    if (pathname.startsWith("/api/v1/")) {
      const writing = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "");
      const localCli = isTrustedLocalAccess(request, server.address(), false, devProxyProof);
      if (!trusted(writing && !localCli)) { sendJson(response, 403, { error: "ACCESS_FORBIDDEN", message: "请求未通过访问来源校验。" }); return; }
    }
    if (pathname === "/api/v1/control-session") {
      response.setHeader("Cache-Control", "no-store");
      if (request.method !== "GET" || !setup.getInitializationState().initialized || !trusted(false)) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      sendJson(response, 200, { token: controlToken }); return;
    }
    if (pathname === "/api/v1/approvals" || pathname === "/api/v1/approvals/decision" || pathname === "/api/v1/approvals/status") {
      response.setHeader("Cache-Control", "no-store");
      if (!setup.getInitializationState().initialized || !trusted(request.method !== "GET") || !controlAuthorized()) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try {
        if (request.method === "GET" && pathname === "/api/v1/approvals/status") {
          const params = new URL(request.url ?? "/", "http://localhost").searchParams;
          const source = params.get("source"), runId = params.get("runId"), callId = params.get("callId"), conversationId = params.get("conversationId");
          if (!runId || !callId || !["web", "qq"].includes(source ?? "") || (source === "web" && !conversationId)) throw new Error("INVALID_INPUT");
          const result = source === "qq" ? qqRuns.callStatus(runId, callId) : toolRuns.callStatus(conversationOwner(conversationId!), runId, callId, conversationId!);
          sendJson(response, 200, { result }); return;
        }
        if (request.method === "GET" && pathname === "/api/v1/approvals") {
          const conversationId = new URL(request.url ?? "/", "http://localhost").searchParams.get("conversationId");
          const items: Record<string, unknown>[] = [];
          if (conversationId && /^[0-9a-f-]{36}$/i.test(conversationId)) for (const [key, runId] of conversationRuns) {
            const [conversation, requestId] = key.split("/"); if (conversation !== conversationId) continue;
            const approval = toolRuns.approvalView(conversationOwner(conversationId), runId);
            if (approval) items.push({ source: "web", conversationId, requestId, runId, ...approval });
          }
          for (const item of qqRuns.approvalViews()) items.push({ source: "qq", scope: item.scope, runId: item.runId, ...item.approval });
          items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.runId).localeCompare(String(b.runId)));
          sendJson(response, 200, { items }); return;
        }
        if (request.method === "POST" && pathname === "/api/v1/approvals/decision") {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          const body = await readSetupBody(request, 8192);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_INPUT");
          const fields = body as Record<string, unknown>;
          if (Object.keys(fields).some(key => !["source", "runId", "callId", "decision", "feedback", "conversationId", "requestId"].includes(key)) || !["web", "qq"].includes(String(fields.source)) || typeof fields.runId !== "string" || typeof fields.callId !== "string" || !["approve", "deny", "feedback"].includes(String(fields.decision)) || (fields.decision === "feedback" ? typeof fields.feedback !== "string" || !fields.feedback.trim() || Buffer.byteLength(fields.feedback, "utf8") > 4000 : fields.feedback !== undefined)) throw new Error("INVALID_INPUT");
          const approved = fields.decision === "approve", feedback = fields.decision === "feedback" ? fields.feedback as string : undefined;
          if (fields.source === "qq") {
            if (fields.conversationId !== undefined || fields.requestId !== undefined) throw new Error("INVALID_INPUT");
            qqRuns.decide(fields.runId, fields.callId, approved, feedback, true);
          } else {
            if (typeof fields.conversationId !== "string" || typeof fields.requestId !== "string" || conversationRuns.get(`${fields.conversationId}/${fields.requestId}`) !== fields.runId) throw new Error("APPROVAL_UNAVAILABLE");
            if (approved && !toolRuns.approvalView(conversationOwner(fields.conversationId), fields.runId)?.canApprove) throw new Error("APPROVAL_UNAVAILABLE");
            toolRuns.decide(conversationOwner(fields.conversationId), fields.runId, fields.callId, approved, feedback);
          }
          sendJson(response, 200, { ok: true }); return;
        }
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      } catch (error) {
        const code = error instanceof Error && ["INVALID_INPUT", "RUN_NOT_FOUND", "APPROVAL_UNAVAILABLE"].includes(error.message) ? error.message : "APPROVAL_UNAVAILABLE";
        sendJson(response, code === "INVALID_INPUT" ? 400 : 409, { error: code });
      }
      return;
    }
    if (pathname === "/api/v1/qq-tool-runs" || pathname.startsWith("/api/v1/qq-tool-runs/")) {
      if (!setup.getInitializationState().initialized || !isTrustedLocalAccess(request, server.address(), request.method !== "GET", devProxyProof) || !adminAuthorized()) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try {
        if (request.method === "GET" && pathname === "/api/v1/qq-tool-runs") { sendJson(response, 200, { runs: qqRuns.list() }); return; }
        const match = /^\/api\/v1\/qq-tool-runs\/([0-9a-f-]{36})(\/decision)?$/.exec(pathname);
        if (!match) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
        if (request.method === "GET" && !match[2]) { sendJson(response, 200, { run: qqRuns.get(match[1]!) }); return; }
        if (request.method === "POST" && match[2]) {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          let body: unknown; try { body = await readSetupBody(request); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          const fields = body as Record<string, unknown>;
          if (Object.keys(fields).sort().join(",") !== "approved,toolCallId" || typeof fields.toolCallId !== "string" || typeof fields.approved !== "boolean") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          qqRuns.decide(match[1]!, fields.toolCallId, fields.approved); sendJson(response, 200, { ok: true }); return;
        }
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      } catch (error) {
        const code = error instanceof Error && ["RUN_NOT_FOUND", "APPROVAL_UNAVAILABLE"].includes(error.message) ? error.message : "RUN_UNAVAILABLE";
        sendJson(response, code === "RUN_NOT_FOUND" ? 404 : code === "APPROVAL_UNAVAILABLE" ? 409 : 500, { error: code });
      }
      return;
    }
    const identityManagement = /^\/api\/v1\/identities\/([0-9a-f-]{36})(?:\/(reassign|detach))?$/i.exec(pathname);
    const editPerson = /^\/api\/v1\/people\/([0-9a-f-]{36})$/i.exec(pathname);
    const undoAudit = /^\/api\/v1\/people\/audit\/([0-9a-f-]{36})\/undo$/i.exec(pathname);
    const undoMerge = /^\/api\/v1\/people\/merge\/([0-9a-f-]{36})\/undo$/i.exec(pathname);
    const batchPath = ["/api/v1/people/merge/preview","/api/v1/people/merge","/api/v1/people/split/preview","/api/v1/people/split"].includes(pathname);
    if (identityManagement || (editPerson && request.method === "PATCH") || undoAudit || undoMerge || batchPath) {
      response.setHeader("Cache-Control", "no-store");
      const reading = !!identityManagement && !identityManagement[2] && request.method === "GET";
      if (!setup.getInitializationState().initialized || !trusted(!reading) || !controlAuthorized()) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try {
        const store = await openConversations();
        if (reading) { const identity = await peopleReader.query(store.databasePath,store.people,"identity",[identityManagement![1]!,0,0]); sendJson(response,200,{ identity }); return; }
        if (!(editPerson && request.method === "PATCH") && !(request.method === "POST" && (identityManagement?.[2] || undoAudit || undoMerge || batchPath))) { sendJson(response,405,{ error: "METHOD_NOT_ALLOWED" }); return; }
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new Error("INVALID_INPUT");
        const body = await readSetupBody(request,16384);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_INPUT");
        const fields = body as Record<string, unknown>, keys = Object.keys(fields).sort().join(",");
        let action: ManagementMutation, args: unknown[];
        if (editPerson && request.method === "PATCH" && keys === "manualName,note,version") { action = "edit"; args = [editPerson[1],fields.version,fields.manualName,fields.note]; }
        else if (identityManagement?.[2] === "reassign" && keys === "reason,targetPersonId,version") { action = "reassign"; args = [identityManagement[1],fields.targetPersonId,fields.version,fields.reason]; }
        else if (identityManagement?.[2] === "detach" && keys === "reason,version") { action = "detach"; args = [identityManagement[1],fields.version,fields.reason]; }
        else if (undoAudit && keys === "reason") { action = "undo"; args = [undoAudit[1],fields.reason]; }
        else if (undoMerge && keys === "reason") { action = "undoMerge"; args = [undoMerge[1],fields.reason]; }
        else if (pathname === "/api/v1/people/merge/preview" && keys === "options,sourceId,targetId") { action = "mergePreview"; args = [fields.sourceId,fields.targetId,fields.options]; }
        else if (pathname === "/api/v1/people/merge" && keys === "fingerprint,options,reason,sourceId,targetId") { action = "merge"; args = [fields.sourceId,fields.targetId,fields.options,fields.fingerprint,fields.reason]; }
        else if (pathname === "/api/v1/people/split/preview" && keys === "identities,sourceId,targetId" && (fields.targetId === null || typeof fields.targetId === "string")) { action = "splitPreview"; args = [fields.sourceId,fields.targetId,fields.identities]; }
        else if (pathname === "/api/v1/people/split" && keys === "fingerprint,identities,reason,sourceId,targetId" && (fields.targetId === null || typeof fields.targetId === "string")) { action = "split"; args = [fields.sourceId,fields.targetId,fields.identities,fields.fingerprint,fields.reason]; }
        else throw new Error("INVALID_INPUT");
        if (action === "merge" || action === "split") {
          const ticket = args[3];
          if (typeof ticket !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(ticket)) throw new Error("INVALID_INPUT");
          const [digest, signature] = ticket.split(".") as [string,string];
          const expected = createHmac("sha256",peoplePreviewKey).update(`${action}:${digest}`).digest("hex");
          if (!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) throw new Error("CONFLICT");
          args[3] = digest;
        }
        let result = await peopleReader.mutate(store.databasePath,store.people,action,args);
        if ((action === "mergePreview" || action === "splitPreview") && result && typeof result === "object") {
          const preview = result as { fingerprint: string }, purpose = action === "mergePreview" ? "merge" : "split";
          const signature = createHmac("sha256",peoplePreviewKey).update(`${purpose}:${preview.fingerprint}`).digest("hex");
          result = { ...preview, fingerprint: `${preview.fingerprint}.${signature}` };
        }
        sendJson(response,200,{ result });
      } catch (error) {
        const code = error instanceof Error && ["NOT_FOUND","INVALID_INPUT","CONFLICT","BATCH_LIMIT"].includes(error.message) ? error.message : "PEOPLE_UNAVAILABLE";
        sendJson(response,code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" || code === "BATCH_LIMIT" ? 400 : code === "CONFLICT" ? 409 : 503,{ error: code });
      }
      return;
    }
    if (/^\/api\/v1\/(people|spaces)(?:\/|$)/.test(pathname)) {
      response.setHeader("Cache-Control", "no-store");
      if (!setup.getInitializationState().initialized || !trusted(false) || !controlAuthorized()) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      const url = new URL(request.url ?? "/", "http://localhost"), params = url.searchParams;
      const limitText = params.get("limit") ?? "20", offsetText = params.get("offset") ?? "0", search = params.get("q") ?? "", state = params.get("state") ?? "active";
      if ([...params.keys()].some(key => !["limit", "offset", "q", "state"].includes(key) || params.getAll(key).length !== 1) || !["active","merged"].includes(state) || !/^[1-9]\d{0,1}$/.test(limitText) || Number(limitText) > 50 || !/^(0|[1-9]\d{0,5})$/.test(offsetText) || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
      const limit = Number(limitText), offset = Number(offsetText), match = /^\/api\/v1\/(people|spaces)(?:\/([0-9a-f-]{36})(?:\/(identities|spaces|members|audit))?)?$/.exec(pathname);
      if (!match) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
      try {
        const store = await openConversations(), [, resource, resourceId, relation] = match;
        const read = (action: ManagementQuery, value: string) => peopleReader.query(store.databasePath, store.people, action, [value, limit + 1, offset, state as "active" | "merged"]);
        if (!resourceId) {
          const items = await read(resource === "people" ? "people" : "spaces", search) as unknown[];
          sendJson(response, 200, { items: items.slice(0,limit), hasMore: items.length > limit, offset, limit }); return;
        }
        if (!relation) { const value = await read(resource === "people" ? "person" : "space", resourceId); sendJson(response, 200, resource === "people" ? { person: value } : { space: value }); return; }
        const action = resource === "people" && relation === "identities" ? "identities"
          : resource === "people" && relation === "spaces" ? "personSpaces"
          : resource === "people" && relation === "audit" ? "audit"
          : resource === "spaces" && relation === "members" ? "members" : null;
        if (!action) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
        const items = await read(action, resourceId) as unknown[];
        sendJson(response, 200, { items: items.slice(0,limit), hasMore: items.length > limit, offset, limit });
      } catch (error) {
        const notFound = error instanceof Error && ["NOT_FOUND", "INVALID_INPUT"].includes(error.message);
        sendJson(response, notFound ? 404 : 503, { error: notFound ? "NOT_FOUND" : "PEOPLE_UNAVAILABLE" });
      }
      return;
    }
    if (pathname === "/api/v1/flow-overview") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (!setup.getInitializationState().initialized || !trusted(false) || !isSameOrigin(request)) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try { sendJson(response, 200, overviewData(trusted(false))); }
      catch { sendJson(response, 500, { error: "FLOW_OVERVIEW_UNAVAILABLE" }); }
      return;
    }
    if (pathname === "/api/v1/capabilities") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (!setup.getInitializationState().initialized || !trusted(false) || !isSameOrigin(request)) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try { sendJson(response, 200, extensions.capabilityCatalog()); }
      catch { sendJson(response, 500, { error: "CAPABILITIES_UNAVAILABLE" }); }
      return;
    }
    if (pathname === "/api/v1/flow-publication" || pathname.startsWith("/api/v1/flow-publication/")) {
      if (!setup.getInitializationState().initialized || !trusted(request.method !== "GET")) { sendJson(response, 403, { error: "LOCAL_ACCESS_REQUIRED" }); return; }
      try {
        const state = flowPublication.read();
        if (request.method === "GET" && pathname === "/api/v1/flow-publication") {
          const skills = typeof extensions.skillSnapshot === "function" ? extensions.skillSnapshot() : [];
          const execution = options.toolExecutionFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_EXECUTION_FLOW === "1";
          const tools = execution || (options.toolAvailabilityFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_FLOW === "1");
          sendJson(response, 200, { ...state, graphs: { ...resolvePublishedGraphs(state.draft), skill: options.skillFlow?.definition ?? builtInSkillFlow(skills) }, skills: skills.map(item => ({ ...item.declaration, enabled: item.enabled, available: item.available, trusted: !!item.load, status: item.status })), skillWarnings: typeof extensions.skillWarnings === "function" ? extensions.skillWarnings() : [], active: { context: conversations?.contextFlowConfiguration().enabled ?? process.env.STARDUST_WEB_CONTEXT_FLOW === "1", tools, execution, skill: options.skillFlow?.enabled ?? process.env.STARDUST_WEB_SKILL_FLOW === "1" } }); return;
        }
        if (request.method !== "POST" || !/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
        const body = await readSetupBody(request, 4096);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_INPUT");
        const fields = body as Record<string, unknown>;
        if (typeof fields.revision !== "string") throw new Error("INVALID_INPUT");
        if (pathname.endsWith("/save") && Object.keys(fields).sort().join(",") === "connections,revision") { sendJson(response, 200, flowPublication.save(fields.revision, fields.connections)); return; }
        if (pathname.endsWith("/validate") && Object.keys(fields).join(",") === "revision") { if (fields.revision !== state.revision) throw new Error("FLOW_CONFLICT"); await flowPublication.validate(state.draft); sendJson(response, 200, { valid: true, revision: state.revision }); return; }
        if (pathname.endsWith("/publish") && Object.keys(fields).join(",") === "revision") { sendJson(response, 200, await flowPublication.publish(fields.revision)); return; }
        if (pathname.endsWith("/reset") && Object.keys(fields).join(",") === "revision") { sendJson(response, 200, flowPublication.reset(fields.revision)); return; }
        throw new Error("INVALID_INPUT");
      } catch (error) { const code = error instanceof Error ? error.message : "FLOW_FAILED"; sendJson(response, code === "FLOW_CONFLICT" ? 409 : code === "INVALID_INPUT" || code === "INVALID_CONNECTIONS" ? 400 : 500, { error: code }); return; }
    }
    if (pathname === "/api/v1/starcore-flows") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (!setup.getInitializationState().initialized || !trusted(false) || !isSameOrigin(request)) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
      try {
        const entries = typeof extensions.flowCatalog === "function" ? extensions.flowCatalog() : [];
        const contextEnabled = conversations?.contextFlowConfiguration().enabled ?? process.env.STARDUST_WEB_CONTEXT_FLOW === "1";
        if (contextEnabled) {
          const web = entries.find(entry => entry.owner === "web-chat");
          if (web?.contract && web.status !== "incompatible") web.contract = webContextDeclaration(web.contract.packageVersion, conversations?.contextFlowConfiguration().definition ?? resolvePublishedGraphs(flowPublication.read().published.connections).context);
        }
        sendJson(response, 200, { entries });
      }
      catch { sendJson(response, 500, { error: "FLOW_CATALOG_UNAVAILABLE" }); }
      return;
    }

    if (pathname === "/api/v1/global-context" || pathname.startsWith("/api/v1/global-context/")) {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        if (!trusted(false)) { sendJson(response, 403, { error: "LOCAL_ONLY" }); return; }
        if (!isSameOrigin(request) || (request.method !== "GET" && !request.headers.origin)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
        const store = (await openConversations()).globalContext;
        if (pathname === "/api/v1/global-context" && request.method === "GET") { sendJson(response, 200, { owner: WEB_CONTEXT_OWNER, entries: store.entries(WEB_CONTEXT_OWNER), counts: store.counts(WEB_CONTEXT_OWNER), lastCompletedAt: store.lastCompletedAt(WEB_CONTEXT_OWNER) }); return; }
        if (pathname === "/api/v1/global-context/jobs" && request.method === "GET") { sendJson(response, 200, { jobs: store.jobs(WEB_CONTEXT_OWNER), counts: store.counts(WEB_CONTEXT_OWNER) }); return; }
        if (pathname === "/api/v1/global-context" && request.method === "DELETE") { store.clear(WEB_CONTEXT_OWNER); sendJson(response, 200, { ok: true }); return; }
        const retry = /^\/api\/v1\/global-context\/jobs\/(\d{1,15})\/retry$/.exec(pathname);
        if (retry && request.method === "POST") {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          let body: unknown; try { body = await readSetupBody(request); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          store.retry(WEB_CONTEXT_OWNER, Number(retry[1])); sendJson(response, 200, { ok: true }); return;
        }
        sendJson(response, 404, { error: "NOT_FOUND" });
      } catch (error) {
        const code = error instanceof Error && ["INVALID_INPUT", "JOB_NOT_RETRYABLE"].includes(error.message) ? error.message : "GLOBAL_CONTEXT_FAILED";
        sendJson(response, code === "INVALID_INPUT" ? 400 : code === "JOB_NOT_RETRYABLE" ? 409 : 500, { error: code });
      }
      return;
    }
    if (pathname === "/api/v1/agent/settings") {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        if (!trusted(false) || !isSameOrigin(request) || (request.method !== "GET" && !request.headers.origin)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
        const store = await openConversations();
        const tools = [{ name: "search_history", description: "跨会话记忆 Tool" }, ...extensions.availableTools().filter((tool) => tool.name !== "search_history").map(({ name, description }) => ({ name, description }))];
        if (request.method === "GET") { sendJson(response, 200, { ...store.agent.settings(), tools: tools.map((tool) => ({ ...tool, enabled: store.agent.toolAllowed(tool.name) })) }); return; }
        if (request.method !== "PATCH" || !/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
        const body = await readSetupBody(request, 32 * 1024);
        store.agent.update(body, tools.map((tool) => tool.name));
        sendJson(response, 200, { ok: true });
      } catch (error) { sendJson(response, error instanceof Error && error.message === "INVALID_INPUT" ? 400 : 500, { error: "INVALID_INPUT" }); }
      return;
    }
    if (pathname === "/api/v1/conversations" || pathname.startsWith("/api/v1/conversations/")) {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        if (!trusted(false)) { sendJson(response, 403, { error: "LOCAL_ONLY" }); return; }
        if (!isSameOrigin(request) || (request.method !== "GET" && !request.headers.origin)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
        const activityRoute = /^\/api\/v1\/conversations\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/activity$/i.exec(pathname);
        if (activityRoute && request.method === "GET") {
          const store = await openConversations();
          store.getWeb(activityRoute[1]!);
          sendJson(response, 200, { activity: store.activity(activityRoute[1]!, activityRoute[2]!) }); return;
        }
        const toolRoute = /^\/api\/v1\/conversations\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/tool(?:\/(decision))?$/i.exec(pathname);
        if (toolRoute) {
          if (!trusted(request.method !== "GET")) { sendJson(response, 403, { error: "UNAVAILABLE" }); return; }
          (await openConversations()).getWeb(toolRoute[1]!);
          const key = `${toolRoute[1]}/${toolRoute[2]}`;
          const runId = conversationRuns.get(key);
          if (!runId) { sendJson(response, request.method === "GET" ? 200 : 409, request.method === "GET" ? { run: null } : { error: "TOOL_UNAVAILABLE" }); return; }
          if (request.method === "GET" && !toolRoute[3]) {
            const run = toolRuns.get(conversationOwner(toolRoute[1]!), runId);
            sendJson(response, 200, { run: { ...run, calls: run.calls.map(({ input, ...call }) => ({ ...call, ...(typeof input?.content === "string" ? { input: { content: input.content } } : {}) })) } }); return;
          }
          if (request.method === "POST" && toolRoute[3]) {
            if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            let body: unknown; try { body = await readSetupBody(request); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || typeof (body as Record<string, unknown>).toolCallId !== "string" || typeof (body as Record<string, unknown>).approved !== "boolean") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            const fields = body as { toolCallId: string; approved: boolean };
            if (fields.approved && !toolRuns.approvalView(conversationOwner(toolRoute[1]!), runId)?.canApprove) throw new Error("APPROVAL_UNAVAILABLE");
            toolRuns.decide(conversationOwner(toolRoute[1]!), runId, fields.toolCallId, fields.approved);
            sendJson(response, 200, { ok: true }); return;
          }
          sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return;
        }
        const match = /^\/api\/v1\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/messages)?$/i.exec(pathname);
        if (pathname !== "/api/v1/conversations" && !match) { sendJson(response, 404, { error: "NOT_FOUND" }); return; }
        const store = await openConversations();
        const id = match?.[1];
        if (id) store.getWeb(id);
        if (request.method === "GET") {
          if (!id) { sendJson(response, 200, { conversations: store.listWeb() }); return; }
          if (!match?.[2]) { sendJson(response, 200, { conversation: store.get(id) }); return; }
          const url = new URL(request.url ?? "/", "http://localhost");
          const after = url.searchParams.get("after") ?? "0", limit = url.searchParams.get("limit") ?? "100";
          if (!/^\d{1,15}$/.test(after) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200 || !Number.isSafeInteger(Number(after))) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          const messages = store.messages(id, Number(after), Number(limit));
          sendJson(response, 200, { messages }); return;
        }
        if (request.method === "DELETE" && id && !match?.[2]) { store.delete(id); sendJson(response, 200, { ok: true }); return; }
        if (request.method !== "POST" && request.method !== "PATCH") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
        let body: unknown;
        try { body = await readSetupBody(request, 64 * 1024); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
        const fields = body as Record<string, unknown>;
        if (!id && request.method === "POST" && Object.keys(fields).every((key) => key === "title") && (fields.title === undefined || typeof fields.title === "string")) {
          sendJson(response, 201, { conversation: store.create(fields.title as string | undefined) }); return;
        }
        if (id && !match?.[2] && request.method === "PATCH" && Object.keys(fields).length === 1 && typeof fields.title === "string") {
          sendJson(response, 200, { conversation: store.rename(id, fields.title) }); return;
        }
        if (id && match?.[2] && request.method === "POST" && Object.keys(fields).every((key) => ["content", "requestId", "retry"].includes(key)) && typeof fields.content === "string" && typeof fields.requestId === "string" && (fields.retry === undefined || typeof fields.retry === "boolean")) {
          if (!webChannelAvailable()) { sendJson(response, 403, { error: "CHANNEL_DISABLED" }); return; }
          const webContext = contextService!.forWeb(id);
          const requestId = fields.requestId;
          const content = fields.content;
          const contextConfig = store.contextFlowConfiguration(), contextEnabled = contextConfig.enabled ?? process.env.STARDUST_WEB_CONTEXT_FLOW === "1";
          const executionEnabled = options.toolExecutionFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_EXECUTION_FLOW === "1";
          const toolEnabled = executionEnabled || (options.toolAvailabilityFlow?.enabled ?? process.env.STARDUST_WEB_TOOL_FLOW === "1");
          const needsPublished = (contextEnabled && !contextConfig.definition) || (toolEnabled && !options.toolAvailabilityFlow?.definition);
          const publishedGraphs = needsPublished ? resolvePublishedGraphs(flowPublication.read().published.connections) : undefined;
          const contextDefinition = contextConfig.definition ?? publishedGraphs?.context;
          const controller = new AbortController();
          const skillEnabled = options.skillFlow?.enabled ?? process.env.STARDUST_WEB_SKILL_FLOW === "1";
          const skillCapabilities = skillEnabled && typeof extensions.requestCapabilities === "function" ? extensions.requestCapabilities({ channel: "web", allowTool: () => false, allowSkill: () => webChannelAvailable() }) : undefined;
          const visibleSkills = skillCapabilities && new Set(skillCapabilities.visible.filter(item => item.kind === "skill").map(item => item.id));
          const skills = skillEnabled && typeof extensions.skillSnapshot === "function" ? extensions.skillSnapshot().map(skill => ({ ...skill, available: skill.available && (!visibleSkills || visibleSkills.has(`skill:${skill.declaration.id}`)), isAvailable: () => skill.isAvailable() && (!skillCapabilities || skillCapabilities.isEligible(`skill:${skill.declaration.id}`)) })) : [];
          const skillGraph = skillEnabled ? structuredClone(options.skillFlow?.definition ?? builtInSkillFlow(skills)) : undefined;
          let assertSkills = () => {};
          let skillBudget: number | undefined;
          const execute = async (context: import("./conversation-context.js").ConversationContextMessage[], activity: (event: Omit<import("./history-agent.js").ModelActivity, "requestId">) => void, evidence: (item: import("./history-search.js").HistoryEvidence) => void) => {
            const key = `${id}/${requestId}`;
            const conversation = store.getWeb(id);
            // Web has no authenticated account binding yet; the shared resolver returns unresolved.
            const webIdentity: IdentityInput = { channelId: "web-chat" };
            const webResolution = await identityResolver.resolve(store.databasePath, store.people, webIdentity);
            const webPersonContext = scopedPersonContext(webIdentity, webResolution);
            const scopedContext = webPersonContext ? [...context.slice(0, -1), webPersonContext, ...context.slice(-1)] : context;
            const result = await agent.execute({
              source: { starcoreId: conversation.starcoreId, channelId: conversation.channelId, conversationId: conversation.id },
              current: content, messages: scopedContext, signal: controller.signal,
            }, async request => {
              const coreAllows = (name: string) => webChannelAvailable() && store.agent.toolAllowed(name);
              const capabilitySnapshot = typeof extensions.requestCapabilities === "function" ? extensions.requestCapabilities({ channel: "web", allowTool: coreAllows, allowSkill: () => false }) : undefined;
              const visibleTools = capabilitySnapshot && new Map(capabilitySnapshot.visible.filter(item => item.kind === "tool").map(item => [item.name, item.id]));
              const selected = toolEnabled ? await runWebToolFlow(options.toolAvailabilityFlow?.definition ?? publishedGraphs?.tools ?? builtInWebToolFlow(), extensions.availableTools().filter(tool => !visibleTools || visibleTools.has(tool.name)), coreAllows, controller.signal) : undefined;
              assertSkills();
              if (controller.signal.aborted) throw new ModelError("REQUEST_CANCELLED", 499);
              const runId = toolRuns.start(conversationOwner(id), request.current, request.messages, {
                searchHistory: input => webContext.search(input, evidence), activity,
                allowTool: name => (!selected || selected.has(name)) && coreAllows(name) && (name === "search_history" || !capabilitySnapshot || (!!visibleTools?.has(name) && capabilitySnapshot.isEligible(visibleTools.get(name)!))),
                ...(skillBudget === undefined ? {} : { maxPromptBytes: skillBudget }),
                ...(executionEnabled ? { executionFlow: options.toolExecutionFlow?.definition ?? builtInWebToolExecutionFlow() } : {}),
              }, request.source);
              conversationRuns.set(key, runId);
              return {
                get: () => toolRuns.get(conversationOwner(id), runId),
                cancel: () => toolRuns.cancel(conversationOwner(id), runId),
                close: () => { conversationRuns.delete(key); },
                isClosed: () => serverClosing,
              };
            });
            return result.content;
          };
          const onClose = () => { if (!response.writableEnded) controller.abort(); };
          response.once("close", onClose);
          let messages;
          try { messages = await webContext.submit(requestId, content, fields.retry === true, execute, { signal: controller.signal, ...(contextDefinition ? { flowDefinition: contextDefinition } : {}), ...(skillGraph ? { prepareSkills: async (context, budget) => {
            const result = await runSkillFlow(skillGraph, skills, content, context, budget, controller.signal);
            if (result.message) skillBudget = budget;
            assertSkills = () => { if (controller.signal.aborted || result.loaded.some(id => { const skill = skills.find(item => item.declaration.id === id); return !skill || skill.signal?.aborted || !skill.isAvailable(); })) throw new SkillFlowError("SKILL_FLOW_CANCELLED"); };
            return { message: result.message, assertAvailable: assertSkills };
          } } : {}) }); }
          finally { response.off("close", onClose); }
          if (!response.destroyed) sendJson(response, 200, { messages });
          return;
        }
        sendJson(response, 400, { error: "INVALID_INPUT" });
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof WebContextFlowError) { sendJson(response, error.code === "CONTEXT_FLOW_CANCELLED" ? 499 : error.reason === "CONTEXT_TOO_LARGE" ? 400 : 500, { error: error.code, reason: error.reason }); return; }
        if (error instanceof WebToolFlowError) { sendJson(response, error.code === "TOOL_FLOW_CANCELLED" ? 499 : 500, { error: error.code }); return; }
        if (error instanceof SkillFlowError) { sendJson(response, error.code === "SKILL_FLOW_CANCELLED" ? 499 : 500, { error: error.code }); return; }
        const code = error instanceof Error && ["NOT_FOUND", "INVALID_INPUT", "CONTEXT_TOO_LARGE", "CONVERSATION_BUSY", "REQUEST_ID_CONFLICT", "RETRY_OUTDATED", "APPROVAL_UNAVAILABLE"].includes(error.message) ? error.message : "CONVERSATION_FAILED";
        sendJson(response, code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" || code === "CONTEXT_TOO_LARGE" ? 400 : ["CONVERSATION_BUSY", "REQUEST_ID_CONFLICT", "RETRY_OUTDATED", "APPROVAL_UNAVAILABLE"].includes(code) ? 409 : 500, { error: code });
      }
      return;
    }
    if (pathname === "/api/v1/tool-runs" || pathname.startsWith("/api/v1/tool-runs/")) {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        if (!trusted(request.method !== "GET")) { sendJson(response, 403, { error: "LOCAL_ONLY" }); return; }
        if (request.method === "POST") {
          if (!request.headers.origin || !isSameOrigin(request)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          let body: unknown; try { body = await readSetupBody(request, 32768); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          const fields = body as Record<string, unknown>;
          const owner = localToolOwner;
          if (pathname === "/api/v1/tool-runs") {
            if (Object.keys(fields).length !== 1 || typeof fields.message !== "string") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            const id = toolRuns.start(owner, fields.message); sendJson(response, 202, { id }); return;
          }
          const decision = /^\/api\/v1\/tool-runs\/([0-9a-f-]{36})\/decision$/.exec(pathname);
          if (decision) {
            if (Object.keys(fields).length !== 2 || typeof fields.toolCallId !== "string" || typeof fields.approved !== "boolean") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            if (fields.approved && !toolRuns.approvalView(owner, decision[1]!)?.canApprove) throw new Error("APPROVAL_UNAVAILABLE");
            toolRuns.decide(owner, decision[1]!, fields.toolCallId, fields.approved); sendJson(response, 202, { ok: true }); return;
          }
        } else if (request.method === "GET") {
          if (!isSameOrigin(request)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
          const owner = localToolOwner;
          const match = /^\/api\/v1\/tool-runs\/([0-9a-f-]{36})$/.exec(pathname);
          if (match) {
            const run = toolRuns.get(owner, match[1]!);
            sendJson(response, 200, { ...run, calls: run.calls.map(({ input, ...call }) => ({ ...call, ...(typeof input?.content === "string" ? { input: { content: input.content } } : {}) })) }); return;
          }
        }
        sendJson(response, 404, { error: "NOT_FOUND" });
      } catch (error) {
        const code = error instanceof Error && ["INVALID_INPUT", "RUN_LIMIT", "RUN_NOT_FOUND", "APPROVAL_UNAVAILABLE"].includes(error.message) ? error.message : "TOOL_RUN_FAILED";
        sendJson(response, code === "RUN_NOT_FOUND" ? 404 : code === "APPROVAL_UNAVAILABLE" ? 409 : code === "INVALID_INPUT" ? 400 : 500, { error: code });
      }
      return;
    }
    if (pathname === "/api/v1/logs" || pathname === "/api/v1/logs/stream") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (!isSameOrigin(request)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      const lastEventId = request.headers["last-event-id"];
      const rawAfter = pathname.endsWith("/stream") ? ((typeof lastEventId === "string" ? lastEventId : "") || url.searchParams.get("after") || "0") : (url.searchParams.get("after") || "0");
      const rawLimit = url.searchParams.get("limit") ?? "200";
      if (!/^\d{1,15}$/.test(rawAfter) || !/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000 || !Number.isSafeInteger(Number(rawAfter))) { sendJson(response, 400, { error: "INVALID_CURSOR" }); return; }
      const after = Number(rawAfter);
      if (pathname === "/api/v1/logs") { sendJson(response, 200, logs.read(after, Number(rawLimit))); return; }
      if (streams.size >= 32) { sendJson(response, 503, { error: "TOO_MANY_SUBSCRIBERS" }); return; }
      response.writeHead(200, { ...securityHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      streams.add(response);
      let closed = false;
      let unsubscribe = (): void => {};
      let blocked = false;
      let timeout: NodeJS.Timeout | undefined;
      let queuedBytes = 0;
      const queued: string[] = [];
      const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); if (timeout) clearTimeout(timeout); unsubscribe(); streams.delete(response); };
      const disconnect = (): void => { close(); response.destroy(); };
      const send = (text: string): void => {
        if (closed || response.destroyed) { disconnect(); return; }
        try {
          if (!response.write(text)) {
            blocked = true;
            timeout = setTimeout(disconnect, 10_000); timeout.unref();
          }
        } catch { disconnect(); }
      };
      const format = (entry: LogEntry): string => `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
      const snapshot = logs.read(after, 1000);
      if ((url.searchParams.has("instance") && url.searchParams.get("instance") !== logs.instanceId) || after > snapshot.latest) {
        response.end(`event: reset\ndata: {}\n\n`); streams.delete(response); return;
      }
      let replayIndex = 0;
      const pump = (): void => {
        while (!closed && !blocked && replayIndex < snapshot.entries.length) send(format(snapshot.entries[replayIndex++]!));
        while (!closed && !blocked && queued.length) { const frame = queued.shift()!; queuedBytes -= Buffer.byteLength(frame); send(frame); }
      };
      const heartbeat = setInterval(() => { if (!blocked && !closed) send(": keepalive\n\n"); }, 20_000);
      heartbeat.unref();
      response.on("close", close);
      response.on("drain", () => { if (timeout) clearTimeout(timeout); timeout = undefined; blocked = false; pump(); });
      unsubscribe = logs.subscribe((entry) => {
        const frame = format(entry);
        if (blocked || replayIndex < snapshot.entries.length || queued.length) {
          queuedBytes += Buffer.byteLength(frame);
          if (queuedBytes > 64 * 1024) { disconnect(); return; }
          queued.push(frame); pump();
        } else send(frame);
      });
      if (snapshot.gap) send(`event: gap\ndata: ${JSON.stringify({ oldest: snapshot.oldest, latest: snapshot.latest })}\n\n`);
      if (!blocked) send(": connected\n\n");
      pump();
      return;
    }

    if (pathname === "/api/v1/software-update/status") {
      if (request.method !== "GET") { sendJson(response,405,{error:"METHOD_NOT_ALLOWED"}); return; }
      try { if (!setup.getInitializationState().initialized) { sendJson(response,403,{error:"SETUP_REQUIRED"}); return; } sendJson(response,200,{enabled:webUpdate.enabled,job:await webUpdate.status(),runningSha:activeSha}); }
      catch { sendJson(response,503,{error:"UPDATE_STATUS_UNAVAILABLE",message:"无法读取更新状态。"}); }
      return;
    }
    if (pathname === "/api/v1/software-update/install") {
      if (request.method !== "POST") { sendJson(response,405,{error:"METHOD_NOT_ALLOWED"}); return; }
      if (!request.headers.origin || !trusted(true) || !/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response,403,{error:"INVALID_ORIGIN"}); return; }
      try {
        if (!setup.getInitializationState().initialized || !webUpdate.enabled) { sendJson(response,403,{error:"UPDATE_DISABLED",message:"WebUI 更新未启用。"}); return; }
        const body=await readSetupBody(request,1024);
        if (!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).length) { sendJson(response,400,{error:"INVALID_INPUT"}); return; }
        const previous=await webUpdate.status();
        if (previous?.running) { sendJson(response,409,{error:"UPDATE_IN_PROGRESS",message:"更新正在进行。"}); return; }
        await webUpdate.start(); sendJson(response,202,{accepted:true,previousJobId:previous?.jobId ?? null});
      } catch (error) { sendJson(response,503,{error:"UPDATE_START_FAILED",message:error instanceof Error ? error.message : "无法启动更新服务。"}); }
      return;
    }

    if (pathname === "/api/v1/software-update/check") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        sendJson(response, 200, await (options.updateCheckForTest ?? checkSoftwareUpdate)(version));
      } catch (error) { sendJson(response, 502, { error: "UPDATE_CHECK_FAILED", message: error instanceof Error && /^远程版本/.test(error.message) ? error.message : "无法连接更新来源，请稍后重试。" }); }
      return;
    }

    if (pathname === "/api/v1/server/settings") {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED", message: "请先完成初始化。" }); return; }
        if (!isSameOrigin(request) || (request.method !== "GET" && !request.headers.origin)) { sendJson(response, 403, { error: "INVALID_ORIGIN", message: "请求来源无效。" }); return; }
        const portOverridden = process.env.STARDUST_PORT !== undefined || loadCoreEnv().STARDUST_PORT !== undefined;
        if (request.method === "POST") {
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ConfigValidationError("请求必须使用 JSON。");
          const input = await readSetupBody(request);
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join(",") !== "port") throw new ConfigValidationError("请提供端口号。");
          setup.savePort((input as { port: unknown }).port);
        } else if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
        const address = server.address();
        sendJson(response, 200, { savedPort: setup.getSetupConfig().server.port, runningPort: address && typeof address !== "string" ? address.port : null, portOverridden });
      } catch (error) {
        const validation = error instanceof ConfigValidationError;
        sendJson(response, validation ? 400 : 500, { error: validation ? "INVALID_INPUT" : "SAVE_FAILED", message: error instanceof Error && (validation || error.message.startsWith("无法保存 config.toml")) ? error.message : "无法读取或保存服务设置，请检查服务日志。" });
      }
      return;
    }

    if (pathname === "/api/v1/setup/state") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      try {
        const state = setup.getInitializationState();
        const config = setup.getSetupConfig();
        sendJson(response, 200, state.initialized ? { ...state, webTitle: config.web.title } : { ...state, config });
      } catch {
        sendJson(response, 500, { error: "SETUP_STATE_UNAVAILABLE" });
      }
      return;
    }

    if (pathname === "/api/v1/setup/complete") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: "INVALID_ORIGIN" });
        return;
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) {
        sendJson(response, 400, { error: "INVALID_INPUT" });
        return;
      }
      let input: ConfigUpdate;
      try {
        input = await readSetupBody(request) as ConfigUpdate;
        validateConfigUpdate(input);
      } catch (error) {
        if (error instanceof RangeError) sendJson(response, 413, { error: "BODY_TOO_LARGE" });
        else sendJson(response, 400, { error: "INVALID_INPUT", message: error instanceof ConfigValidationError ? error.message : "无效的请求数据" });
        return;
      }
      try {
        await setup.completeInitialization(input);
        void extensions.restore().catch(() => {});
        sendJson(response, 200, { initialized: true });
      } catch (error) {
        if (error instanceof AlreadyInitializedError) sendJson(response, 409, { error: "ALREADY_INITIALIZED" });
        else sendJson(response, 500, { error: "SETUP_FAILED", message: error instanceof Error && error.message.startsWith("无法保存 config.toml") ? error.message : "初始化保存失败，请检查服务日志和配置文件权限。" });
      }
      return;
    }

    if (pathname === "/api/v1/extensions" || pathname.startsWith("/api/v1/extensions/")) {
      try {
        if (!setup.getInitializationState().initialized) throw new ExtensionError("SETUP_REQUIRED", 403);
        if (pathname === "/api/v1/extensions" && request.method === "GET") { sendJson(response, 200, { extensions: extensions.list() }); return; }
        const targetsMatch = /^\/api\/v1\/extensions\/([a-z0-9-]+)\/capability-targets$/.exec(pathname);
        if (targetsMatch && request.method === "GET") { sendJson(response, 200, { targets: extensions.capabilityTargets(targetsMatch[1]!) }); return; }
        if (request.method !== "POST") throw new ExtensionError("METHOD_NOT_ALLOWED", 405);
        if (!isSameOrigin(request)) throw new ExtensionError("INVALID_ORIGIN", 403);
        const match = /^\/api\/v1\/extensions\/([a-z0-9-]+)\/(install|config|enable|disable|uninstall|capability-test|tool|skill)$/.exec(pathname);
        if (!match) throw new ExtensionError("EXTENSION_NOT_FOUND", 404);
        const multipartCapability = match[2] === "capability-test" && /^multipart\/form-data\s*;/i.test(request.headers["content-type"] ?? "");
        if (!multipartCapability && !/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ExtensionError("INVALID_INPUT");
        let body: unknown;
        try { body = multipartCapability ? await readCapabilityForm(request) : await readSetupBody(request, match[2] === "capability-test" ? 32 * 1024 : 32 * 1024); }
        catch (error) { throw error instanceof RangeError ? new ExtensionError("BODY_TOO_LARGE", 413) : new ExtensionError("INVALID_INPUT"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExtensionError("INVALID_INPUT");
        const fields = body as Record<string, unknown>;
        const id = match[1]!;
        switch (match[2]) {
          case "install": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.install(id); break;
          case "config": await extensions.saveConfig(id, fields); break;
          case "enable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.enable(id); break;
          case "disable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.disable(id); break;
          case "uninstall": if (Object.keys(fields).length !== 1 || typeof fields.deleteConfig !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.uninstall(id, fields.deleteConfig); break;
          case "tool": if (Object.keys(fields).length !== 2 || typeof fields.name !== "string" || typeof fields.enabled !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.setToolEnabled(id, fields.name, fields.enabled); break;
          case "skill": if (Object.keys(fields).length !== 2 || typeof fields.id !== "string" || typeof fields.enabled !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.setSkillEnabled(id, fields.id, fields.enabled); break;
          case "capability-test": {
            const allowed = new Set(["targetId", "kind", "requestId", "mode", "stream", "imageUrl1", "imageUrl2", "imageFiles"]);
            const localImageTest = fields.kind === "private-markdown-local-multi-image" || fields.kind === "group-markdown-local-multi-image";
            if (!Object.hasOwn(fields, "targetId") || !Object.hasOwn(fields, "kind") || !Object.hasOwn(fields, "requestId") || Object.keys(fields).some((key) => !allowed.has(key)) || typeof fields.targetId !== "string" || typeof fields.kind !== "string" || typeof fields.requestId !== "string" || (fields.mode !== undefined && fields.mode !== "active" && fields.mode !== "passive") || (fields.stream !== undefined && typeof fields.stream !== "boolean") || (fields.imageUrl1 !== undefined && typeof fields.imageUrl1 !== "string") || (fields.imageUrl2 !== undefined && typeof fields.imageUrl2 !== "string") || (localImageTest !== multipartCapability) || (multipartCapability && !localImageTest) || (!multipartCapability && Object.hasOwn(fields, "imageFiles"))) throw new ExtensionError("INVALID_INPUT");
            const result = await extensions.runCapabilityTest(id, { targetId: fields.targetId, kind: fields.kind, requestId: fields.requestId, ...(fields.mode === undefined ? {} : { mode: fields.mode as "active" | "passive" }), ...(fields.stream === undefined ? {} : { stream: fields.stream }), ...(fields.imageUrl1 === undefined ? {} : { imageUrl1: fields.imageUrl1 }), ...(fields.imageUrl2 === undefined ? {} : { imageUrl2: fields.imageUrl2 }), ...(fields.imageFiles === undefined ? {} : { imageFiles: fields.imageFiles as [Buffer, Buffer] }) });
            sendJson(response, 200, { result }); return;
          }
        }
        sendJson(response, 200, { ok: true });
      } catch (error) {
        if (error instanceof ExtensionError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 500, { error: "EXTENSION_FAILED" });
      }
      return;
    }

    if (["/api/v1/model/config", "/api/v1/model/test", "/api/v1/model/chat", "/api/v1/model/chat-stream", "/api/v1/model/list"].includes(pathname)) {
      try {
        if (!setup.getInitializationState().initialized) throw new ModelError("SETUP_REQUIRED", 403);
        if (pathname === "/api/v1/model/config" && request.method === "GET") { sendJson(response, 200, model.getConfig()); return; }
        if (request.method !== "POST") { response.setHeader("Allow", pathname.endsWith("/config") ? "GET, POST" : "POST"); throw new ModelError("METHOD_NOT_ALLOWED", 405); }
        if (!isSameOrigin(request)) throw new ModelError("INVALID_ORIGIN", 403);
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ModelError("INVALID_INPUT", 400);
        let body: unknown;
        try { body = await readSetupBody(request, 64 * 1024); }
        catch (error) { throw error instanceof RangeError ? new ModelError("BODY_TOO_LARGE", 413) : new ModelError("INVALID_INPUT", 400); }
        if (pathname === "/api/v1/model/config") { sendJson(response, 200, model.saveConfig(body)); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ModelError("INVALID_INPUT", 400);
        const fields = body as Record<string, unknown>;
        const cancellation = new AbortController();
        const onClose = () => { if (!response.writableEnded) cancellation.abort(); };
        response.on("close", onClose);
        if (response.destroyed) cancellation.abort();
        try {
          if (pathname === "/api/v1/model/list") {
            if (Object.keys(fields).length) throw new ModelError("INVALID_INPUT", 400);
            const result = await model.listModels(cancellation.signal);
            if (!response.destroyed) sendJson(response, 200, result);
          } else if (pathname === "/api/v1/model/test") {
            if (Object.keys(fields).length) throw new ModelError("INVALID_INPUT", 400);
            await model.testConnection(cancellation.signal);
            if (!response.destroyed) sendJson(response, 200, { ok: true });
          } else if (pathname === "/api/v1/model/chat-stream") {
            if (Object.keys(fields).some((key) => key !== "message")) throw new ModelError("INVALID_INPUT", 400);
            response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
            response.flushHeaders();
            const send = (event: string, data: unknown) => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            try {
              let emitted = false;
              const reply = await model.chat(fields.message, cancellation.signal, undefined, (chunk) => { emitted = true; send("delta", { content: chunk }); });
              if (!emitted) send("delta", { content: reply });
              send("done", {});
            } catch (error) {
              send("error", { error: error instanceof ModelError ? error.diagnostic : { source: "stardust", category: "MODEL_SERVICE_FAILED", code: "MODEL_SERVICE_FAILED" } });
            }
            if (!response.destroyed) response.end();
          } else {
            if (Object.keys(fields).some((key) => key !== "message")) throw new ModelError("INVALID_INPUT", 400);
            const reply = await model.chat(fields.message, cancellation.signal);
            if (!response.destroyed) sendJson(response, 200, { reply });
          }
        } finally { response.off("close", onClose); }
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof ModelError) sendJson(response, error.status, { error: error.diagnostic });
        else {
          logs.write("ERROR", "server", "模型服务内部错误，无法安全提供详细信息。");
          sendJson(response, 500, { error: { source: "stardust", category: "MODEL_SERVICE_FAILED", code: "MODEL_SERVICE_FAILED" } });
        }
      }
      return;
    }

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      sendJson(response, 200, {
        status: "ok",
        service: "Stardust",
        version,
        runningSha: activeSha,
        startedAt: startedAt.toISOString(),
        uptimeMs: Math.max(0, Date.now() - startedAt.getTime()),
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const staticFile = staticFiles[pathname];
    const fontPath = /^\/fonts\/(?:wght\.css|LICENSE|files\/noto-sans-sc-[a-z0-9-]+\.woff2)$/.test(pathname) ? pathname.slice(1) : undefined;
    if (!staticFile && !fontPath) {
      sendJson(response, 404, { error: "NOT_FOUND" });
      return;
    }

    try {
      const file = await readFile(join(staticDir, staticFile?.filename ?? fontPath!));
      response.writeHead(200, {
        ...securityHeaders,
        "Content-Type": staticFile?.contentType ?? (fontPath?.endsWith(".css") ? "text/css; charset=utf-8" : fontPath?.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8"),
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : file);
    } catch (error) {
      logs.write("ERROR", "server", "静态资源读取失败。");
      sendJson(response, 500, { error: "STATIC_FILE_UNAVAILABLE" });
    }
  });
  server.on("listening", () => { try { if (setup.getInitializationState().initialized) { void extensions.restore().catch(() => logs.write("ERROR", "extensions", "恢复已启用扩展失败。")); if (options.startConversations || options.conversationService) void openConversations().catch(() => logs.write("ERROR", "global-context", "无法打开会话数据库。")); } } catch { logs.write("ERROR", "server", "读取初始化状态失败。"); } });
  server.on("close", () => { serverClosing = true; peopleObserver.shutdown(); peopleReader.shutdown(); identityResolver.shutdown(); scopedHistory.shutdown(); contextService?.shutdown(); qqRuns.shutdown(); toolRuns.shutdown(); void extensions.shutdown(); try { conversations?.close(); } catch { logs.write("ERROR", "server", "会话数据库关闭失败。"); } });
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { for (const stream of streams) stream.end(); return closeServer(callback); }) as typeof server.close;
  return server;
}
