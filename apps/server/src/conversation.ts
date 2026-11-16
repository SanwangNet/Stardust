import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectConfigRoot } from "./env.js";
import { buildConversationContext, type ConversationContextMessage } from "./conversation-context.js";
import { ModelError } from "./model.js";

export type Conversation = { id: string; title: string; source: string; createdAt: string; updatedAt: string };
export type ConversationMessage = { id: string; conversationId: string; role: "user" | "assistant"; content: string; createdAt: string; status: "pending" | "complete" | "failed" | "unknown"; requestId: string; sequence: number };
export interface ConversationModel {
  chatContext(messages: ConversationContextMessage[], signal?: AbortSignal): Promise<string>;
}

/** Single-server conversation store. Request IDs are unique within a conversation. */
export class ConversationService {
  private readonly db: DatabaseSync;
  private readonly running = new Set<string>();

  constructor(private readonly model: ConversationModel, path = join(projectConfigRoot, "data", "conversations.sqlite"), private readonly budgetBytes = 48_000, private readonly recentMessageLimit = 50) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version > 1) { this.db.close(); throw new Error("UNSUPPORTED_SCHEMA"); }
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','failed','unknown')), request_id TEXT NOT NULL, UNIQUE(conversation_id, request_id, role));
      CREATE INDEX messages_conversation_sequence ON messages(conversation_id, sequence);
      PRAGMA user_version = 1; COMMIT;`);
    this.db.prepare("UPDATE messages SET status = 'unknown' WHERE status = 'pending'").run();
  }

  create(title = "新对话", source = "web"): Conversation {
    if (typeof title !== "string" || !title.trim() || title.length > 120 || !/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new Error("INVALID_INPUT");
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)").run(id, title.trim(), source, now, now);
    return this.get(id);
  }
  list(): Conversation[] {
    return this.db.prepare("SELECT id, title, source, created_at AS createdAt, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC, id DESC").all() as unknown as Conversation[];
  }
  get(id: string): Conversation {
    const row = this.db.prepare("SELECT id, title, source, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?").get(id);
    if (!row) throw new Error("NOT_FOUND");
    return row as unknown as Conversation;
  }
  messages(id: string, after = 0, limit = -1): ConversationMessage[] {
    this.get(id);
    return this.db.prepare("SELECT sequence, id, conversation_id AS conversationId, role, content, created_at AS createdAt, status, request_id AS requestId FROM messages WHERE conversation_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?").all(id, after, limit) as unknown as ConversationMessage[];
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
  async submit(id: string, requestId: string, content: string, retry = false, execute?: (context: ConversationContextMessage[]) => Promise<string>): Promise<ConversationMessage[]> {
    this.get(id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 32_000) throw new Error("INVALID_INPUT");
    const allMessages = this.messages(id);
    const existing = allMessages.filter((message) => message.requestId === requestId);
    if (existing.length) {
      if (existing[0]?.content !== content) throw new Error("REQUEST_ID_CONFLICT");
      if (!retry || existing[0]?.status === "pending" || existing[0]?.status === "complete") return existing;
      if (allMessages.at(-1)?.id !== existing[0]?.id) throw new Error("RETRY_OUTDATED");
    } else if (retry) {
      throw new Error("NOT_FOUND");
    }
    if (this.running.has(id)) throw new Error("CONVERSATION_BUSY");
    const history = allMessages.filter((message) => message.status === "complete").map(({ role, content: text }) => ({ role, content: text }));
    const context = buildConversationContext(history, content, this.budgetBytes, [], this.recentMessageLimit);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (retry) this.db.prepare("UPDATE messages SET status = 'pending' WHERE conversation_id = ? AND request_id = ? AND role = 'user'").run(id, requestId);
      else this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, status, request_id) VALUES (?, ?, 'user', ?, ?, 'pending', ?)").run(randomUUID(), id, content, now, requestId);
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.running.add(id);
    try {
      let reply: string;
      try {
        reply = await (execute ? execute(context) : this.model.chatContext(context));
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
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        try { this.db.prepare("UPDATE messages SET status = 'unknown' WHERE conversation_id = ? AND request_id = ? AND role = 'user' AND status = 'pending'").run(id, requestId); } catch { /* Preserve the database error. */ }
        throw error;
      }
    } finally { this.running.delete(id); }
    return this.messages(id).filter((message) => message.requestId === requestId);
  }
  close(): void {
    if (this.running.size) throw new Error("CONVERSATION_BUSY");
    this.db.close();
  }
}
