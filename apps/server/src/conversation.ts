import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectConfigRoot } from "./env.js";
import { buildConversationContext, type ConversationContextMessage } from "./conversation-context.js";
import { ModelError } from "./model.js";
import { GlobalContextService, migrateGlobalContext, migrateGlobalContextOutcome, migrateGlobalContextEvidence, WEB_CONTEXT_OWNER } from "./global-context.js";
import { assembleContext } from "./context-assembler.js";
import { searchHistory, type HistoryEvidence } from "./history-search.js";
import type { HistoryToolModel, ModelActivity } from "./history-agent.js";
import { logger } from "./logger.js";
import { AgentCore, migrateAgentCore, WEB_CHANNEL_ID, WEB_SCOPE_ID, WEB_STARCORE_ID } from "./agent-core.js";
import { migratePeople, migratePeopleManagement, migratePeopleMerge, PeopleRepository } from "./people.js";
import { builtInWebContextFlow, runWebContextFlow } from "./web-context-flow.js";
import type { ExecutableFlow } from "./executable-flow.js";

export type Conversation = { id: string; title: string; source: string; starcoreId: string; channelId: string; scopeId: string; createdAt: string; updatedAt: string };
export type ConversationMessage = { id: string; conversationId: string; role: "user" | "assistant"; content: string; createdAt: string; status: "pending" | "complete" | "failed" | "unknown"; requestId: string; sequence: number };
export interface ConversationModel {
  chatContext(messages: ConversationContextMessage[], signal?: AbortSignal): Promise<string>;
  synthesizeGlobalContext?(system: string, input: string, signal?: AbortSignal): Promise<string>;
  chatWithTools?: HistoryToolModel["chatWithTools"];
}
export type ConversationOptions = { contextFlow?: { enabled: boolean; definition?: ExecutableFlow } };

/** Single-server conversation store. Request IDs are unique within a conversation. */
export class ConversationService {
  private readonly db: DatabaseSync;
  private readonly running = new Set<string>();
  private readonly activities = new Map<string, ModelActivity>();
  readonly globalContext: GlobalContextService;
  readonly agent: AgentCore;
  readonly people: PeopleRepository;
  readonly databasePath: string;

  /** Read-only runtime configuration for the flow overview; no request data is exposed. */
  contextFlowConfiguration(): { enabled?: boolean; definition?: ExecutableFlow; historyToolSupported: boolean } {
    return { enabled: this.options.contextFlow?.enabled, definition: this.options.contextFlow?.definition && structuredClone(this.options.contextFlow.definition), historyToolSupported: typeof this.model.chatWithTools === "function" };
  }

  constructor(private readonly model: ConversationModel, path = join(projectConfigRoot, "data", "conversations.sqlite"), private readonly budgetBytes = 48_000, private readonly recentMessageLimit = 50, private readonly options: ConversationOptions = {}) {
    this.databasePath = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 8) throw new Error("UNSUPPORTED_SCHEMA");
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','failed','unknown')), request_id TEXT NOT NULL, UNIQUE(conversation_id, request_id, role));
      CREATE INDEX messages_conversation_sequence ON messages(conversation_id, sequence);
      PRAGMA user_version = 1; COMMIT;`);
    if (version < 2) migrateGlobalContext(this.db);
    if (version < 3) migrateGlobalContextOutcome(this.db);
    if (version < 4) migrateGlobalContextEvidence(this.db);
    if (version < 5) migrateAgentCore(this.db);
    if (version < 6) migratePeople(this.db);
    if (version < 7) migratePeopleManagement(this.db);
    if (version < 8) migratePeopleMerge(this.db);
    this.db.prepare("UPDATE messages SET status = 'unknown' WHERE status = 'pending'").run();
    this.globalContext = new GlobalContextService(this.db, model.synthesizeGlobalContext ? { synthesizeGlobalContext: model.synthesizeGlobalContext.bind(model) } : undefined);
    this.agent = new AgentCore(this.db);
    this.people = new PeopleRepository(this.db);
    } catch (error) { try { this.db.close(); } catch {} throw error; }
  }

  create(title = "新对话", source = "web"): Conversation {
    if (typeof title !== "string" || !title.trim() || title.length > 120 || !/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new Error("INVALID_INPUT");
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO conversations (id,title,source,created_at,updated_at,starcore_id,channel_id,scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, title.trim(), source, now, now, source === "web" ? WEB_STARCORE_ID : source, source, source === "web" ? WEB_SCOPE_ID : `unbound:${source}`);
    return this.get(id);
  }
  list(): Conversation[] {
    return this.db.prepare("SELECT id, title, source, starcore_id AS starcoreId, channel_id AS channelId, scope_id AS scopeId, created_at AS createdAt, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC, id DESC").all() as unknown as Conversation[];
  }
  get(id: string): Conversation {
    const row = this.db.prepare("SELECT id, title, source, starcore_id AS starcoreId, channel_id AS channelId, scope_id AS scopeId, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?").get(id);
    if (!row) throw new Error("NOT_FOUND");
    return row as unknown as Conversation;
  }
  messages(id: string, after = 0, limit = -1): ConversationMessage[] {
    this.get(id);
    return this.db.prepare("SELECT sequence, id, conversation_id AS conversationId, role, content, created_at AS createdAt, status, request_id AS requestId FROM messages WHERE conversation_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?").all(id, after, limit) as unknown as ConversationMessage[];
  }
  private requestMessages(id: string, requestId: string): ConversationMessage[] {
    return this.db.prepare("SELECT sequence, id, conversation_id AS conversationId, role, content, created_at AS createdAt, status, request_id AS requestId FROM messages WHERE conversation_id = ? AND request_id = ? ORDER BY sequence ASC").all(id, requestId) as unknown as ConversationMessage[];
  }
  private readRecentContext(id: string) {
    return this.messages(id).filter((message) => message.status === "complete").map(({ role, content, sequence }) => ({ role, content, sequence }));
  }
  rename(id: string, title: string): Conversation {
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error("INVALID_INPUT");
    const result = this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title.trim(), new Date().toISOString(), id);
    if (!result.changes) throw new Error("NOT_FOUND");
    return this.get(id);
  }
  delete(id: string): void {
    if (this.running.has(id)) throw new Error("CONVERSATION_BUSY");
    if (!this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes) throw new Error("NOT_FOUND");
  }
  activity(id: string, requestId: string): ModelActivity | null {
    this.get(id);
    return this.activities.get(`${id}/${requestId}`) ?? null;
  }
  getWeb(id: string): Conversation { const item = this.get(id); if (item.channelId !== WEB_CHANNEL_ID || item.scopeId !== WEB_SCOPE_ID) throw new Error("NOT_FOUND"); return item; }
  listWeb(): Conversation[] { return this.list().filter((item) => item.channelId === WEB_CHANNEL_ID && item.scopeId === WEB_SCOPE_ID); }
  searchHistory(input: unknown, onResult?: (evidence: HistoryEvidence) => void) {
    return searchHistory(this.db, WEB_CONTEXT_OWNER, input, onResult);
  }
  async submit(id: string, requestId: string, content: string, retry = false, execute?: (context: ConversationContextMessage[], activity: (activity: Omit<ModelActivity, "requestId">) => void, evidence: (item: HistoryEvidence) => void) => Promise<string>, options: { signal?: AbortSignal; flowDefinition?: ExecutableFlow; prepareSkills?: (context: ConversationContextMessage[], budgetBytes: number) => Promise<{ message?: ConversationContextMessage; assertAvailable: () => void }> } = {}): Promise<ConversationMessage[]> {
    const conversation = this.get(id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 32_000) throw new Error("INVALID_INPUT");
    const existing = this.requestMessages(id, requestId);
    if (existing.length) {
      if (existing[0]?.content !== content) throw new Error("REQUEST_ID_CONFLICT");
      if (!retry || existing[0]?.status === "pending" || existing[0]?.status === "complete") return existing;
      const last = this.db.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1").get(id);
      if (last?.id !== existing[0]?.id) throw new Error("RETRY_OUTDATED");
    } else if (retry) {
      throw new Error("NOT_FOUND");
    }
    if (this.running.has(id)) throw new Error("CONVERSATION_BUSY");
    // The graph can await nodes, so reserve the conversation before the first await.
    this.running.add(id);
    try {
      const useHistoryTool = conversation.channelId === WEB_CHANNEL_ID && conversation.scopeId === WEB_SCOPE_ID && Boolean(this.model.chatWithTools);
      const graphEnabled = (this.options.contextFlow?.enabled ?? process.env.STARDUST_WEB_CONTEXT_FLOW === "1") && conversation.channelId === WEB_CHANNEL_ID && conversation.scopeId === WEB_SCOPE_ID;
      let context: ConversationContextMessage[], selectedEntryIds: string[] = [];
      if (graphEnabled) {
        const assembled = await runWebContextFlow(options.flowDefinition ?? this.options.contextFlow?.definition ?? builtInWebContextFlow(), {
          recent: () => this.readRecentContext(id), global: () => this.globalContext.entries(WEB_CONTEXT_OWNER),
        }, { conversationId: id, current: content, instructions: useHistoryTool ? this.agent.instructions() : "", budgetBytes: this.budgetBytes, recentLimit: this.recentMessageLimit, useHistoryTool, signal: options.signal });
        context = assembled.messages; selectedEntryIds = assembled.selectedEntryIds;
      } else {
        const history = this.readRecentContext(id);
        const assembled = useHistoryTool ? assembleContext(history, content, id, this.globalContext.entries(WEB_CONTEXT_OWNER), Math.min(this.budgetBytes, 36_000), this.recentMessageLimit, this.agent.instructions()) : undefined;
        context = assembled?.messages ?? buildConversationContext(history.map(({ role, content: text }) => ({ role, content: text })), content, this.budgetBytes, [], this.recentMessageLimit);
        selectedEntryIds = assembled?.selectedEntryIds ?? [];
      }
      let assertSkills = () => {};
      if (options.prepareSkills && conversation.channelId === WEB_CHANNEL_ID && conversation.scopeId === WEB_SCOPE_ID) {
        const hasSystem = context.some(message => message.role === "system");
        const withInstructions: ConversationContextMessage[] = hasSystem ? context : [{ role: "system", content: this.agent.instructions() }, ...context];
        const skills = await options.prepareSkills(withInstructions, this.budgetBytes);
        assertSkills = skills.assertAvailable;
        if (skills.message) context = [...withInstructions.slice(0, -1), skills.message, ...withInstructions.slice(-1)];
        assertSkills();
      }
      for (const entryId of selectedEntryIds) logger.write("DEBUG", "context", "已选取全局上下文条目。", { requestId, code: entryId });
      const now = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (retry) this.db.prepare("UPDATE messages SET status = 'pending' WHERE conversation_id = ? AND request_id = ? AND role = 'user'").run(id, requestId);
        else this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, status, request_id) VALUES (?, ?, 'user', ?, ?, 'pending', ?)").run(randomUUID(), id, content, now, requestId);
        this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      const evidenceEpoch = this.globalContext.epoch(WEB_CONTEXT_OWNER);
      const evidence = new Map<number, HistoryEvidence>();
      let reply: string;
      try {
        const key = `${id}/${requestId}`;
        const setActivity = (activity: Omit<ModelActivity, "requestId">) => this.activities.set(key, { requestId, ...activity });
        try { assertSkills(); reply = execute ? await execute(context, setActivity, (item) => { if (evidence.size < 30 && !evidence.has(item.sequence)) evidence.set(item.sequence, item); }) : await this.model.chatContext(context); }
        finally { this.activities.delete(key); }
        if (typeof reply !== "string" || !reply.trim()) throw new Error("INVALID_RESPONSE");
      } catch (error) {
        const uncertain = error instanceof ModelError && ["NETWORK_ERROR", "TIMEOUT", "REQUEST_CANCELLED", "STREAM_INCOMPLETE"].includes(error.code);
        this.db.prepare("UPDATE messages SET status = ? WHERE conversation_id = ? AND request_id = ? AND role = 'user' AND status = 'pending'").run(uncertain ? "unknown" : "failed", id, requestId);
        throw error;
      }
      const completed = new Date().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE messages SET status = 'complete' WHERE conversation_id = ? AND request_id = ? AND role = 'user'").run(id, requestId);
        this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, status, request_id) VALUES (?, ?, 'assistant', ?, ?, 'complete', ?)").run(randomUUID(), id, reply, completed, requestId);
        this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(completed, id);
        if (conversation.channelId === WEB_CHANNEL_ID && conversation.scopeId === WEB_SCOPE_ID) {
          const range = this.db.prepare("SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM messages WHERE conversation_id = ? AND request_id = ? AND status = 'complete'").get(id, requestId);
          this.globalContext.enqueue(WEB_CONTEXT_OWNER, id, requestId, Number(range?.first), Number(range?.last), completed, evidenceEpoch === this.globalContext.epoch(WEB_CONTEXT_OWNER) ? [...evidence.values()] : []);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        try { this.db.prepare("UPDATE messages SET status = 'unknown' WHERE conversation_id = ? AND request_id = ? AND role = 'user' AND status = 'pending'").run(id, requestId); } catch { /* Preserve the database error. */ }
        throw error;
      }
      this.globalContext.wake();
      return this.requestMessages(id, requestId);
    } finally { this.running.delete(id); }
  }
  close(): void {
    this.globalContext.stop();
    if (this.running.size) throw new Error("CONVERSATION_BUSY");
    this.db.close();
  }
}
