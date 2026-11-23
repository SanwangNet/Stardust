import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PeopleRepository } from "./people.js";
import { resolveIdentity } from "./identity-resolver.js";
import type { ChannelMessage } from "./channel.js";

/** A range is a query dimension, never an authorization grant. */
export type HistoryScope = "CURRENT_CONVERSATION" | "CURRENT_SPACE" | "SAME_IDENTITY" | "SAME_PERSON" | "OTHER_CHANNEL";
export function migrateHistoryProvenance(db: DatabaseSync): void {
 db.exec("BEGIN IMMEDIATE");
 try {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 9) { db.exec("COMMIT"); return; }
  if (version !== 8) throw new Error("UNSUPPORTED_SCHEMA");
  db.exec(`CREATE TABLE message_provenance (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT, provider TEXT, conversation_type TEXT CHECK(conversation_type IN ('web','private','group') OR conversation_type IS NULL),
    author_kind TEXT NOT NULL CHECK(author_kind IN ('platform_user','web_user','agent','tool','system','unknown')),
    provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('trusted_channel','web_local','legacy','unknown','conflict')),
    identity_state TEXT NOT NULL CHECK(identity_state IN ('known','unknown','not_applicable','conflict')),
    space_state TEXT NOT NULL CHECK(space_state IN ('known','unknown','not_applicable','conflict')),
    identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT, space_id TEXT REFERENCES spaces(id) ON DELETE RESTRICT,
    account_key TEXT, sender_key TEXT, space_key TEXT, event_key TEXT, observed_at TEXT,
    CHECK((identity_state='known') = (identity_id IS NOT NULL)), CHECK((space_state='known') = (space_id IS NOT NULL))
  );
  CREATE INDEX provenance_identity ON message_provenance(identity_id, message_id);
  CREATE INDEX provenance_space ON message_provenance(space_id, message_id);
  CREATE INDEX provenance_channel ON message_provenance(channel_id, message_id);
  CREATE UNIQUE INDEX provenance_event ON message_provenance(channel_id, account_key, event_key) WHERE event_key IS NOT NULL AND author_kind='platform_user';
  INSERT INTO message_provenance(message_id,channel_id,provider,conversation_type,author_kind,provenance_kind,identity_state,space_state,observed_at)
  SELECT m.id, CASE WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'web-chat' END,
   CASE WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'web' END,
   CASE WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'web' END,
   CASE WHEN m.role='assistant' THEN 'agent' WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'web_user' ELSE 'unknown' END,
   CASE WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'web_local' ELSE 'unknown' END,
   CASE WHEN m.role='assistant' THEN 'not_applicable' ELSE 'unknown' END,
   CASE WHEN c.channel_id='web' AND c.scope_id='web:default' THEN 'not_applicable' ELSE 'unknown' END, m.created_at
  FROM messages m JOIN conversations c ON c.id=m.conversation_id;
  CREATE TRIGGER message_provenance_default AFTER INSERT ON messages BEGIN
   INSERT INTO message_provenance(message_id,channel_id,provider,conversation_type,author_kind,provenance_kind,identity_state,space_state,observed_at)
   SELECT NEW.id, CASE WHEN channel_id='web' AND scope_id='web:default' THEN 'web-chat' END,
    CASE WHEN channel_id='web' AND scope_id='web:default' THEN 'web' END,
    CASE WHEN channel_id='web' AND scope_id='web:default' THEN 'web' END,
    CASE WHEN NEW.role='assistant' THEN 'agent' WHEN channel_id='web' AND scope_id='web:default' THEN 'web_user' ELSE 'unknown' END,
    CASE WHEN channel_id='web' AND scope_id='web:default' THEN 'web_local' ELSE 'unknown' END,
    CASE WHEN NEW.role='assistant' THEN 'not_applicable' ELSE 'unknown' END,
    CASE WHEN channel_id='web' AND scope_id='web:default' THEN 'not_applicable' ELSE 'unknown' END, NEW.created_at
   FROM conversations WHERE id=NEW.conversation_id;
  END;
  PRAGMA user_version=9;`);
  db.exec("COMMIT");
 } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const valid = (s: unknown, max: number): s is string => typeof s === 'string' && !!s && s === s.trim() && Buffer.byteLength(s,'utf8') <= max && !/[\u0000-\u001f\u007f]/.test(s);
export function qqKeys(message: ChannelMessage) {
 if (message.channelId !== 'qq-bot' || !valid(message.identityAccountId,512) || !valid(message.senderId,1024) || !valid(message.conversationId,1024) || !valid(message.messageId,1024) || !['private','group'].includes(message.conversationType) || typeof message.content !== 'string' || !message.content.trim() || Buffer.byteLength(message.content,'utf8') > 32000) throw new Error('INVALID_QQ_PROVENANCE');
 return { conversationId: hash('qq',message.identityAccountId,message.conversationType,message.conversationId), eventKey: hash(message.conversationType,message.conversationId,message.messageId) };
}
/** Called only from Core after QQ channel admission. Idempotent, including after restart. */
export function recordQQ(db: DatabaseSync, message: ChannelMessage, reply?: string): void {
 const keys = qqKeys(message), account = message.identityAccountId!, now = new Date().toISOString();
 const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(Math.min(Date.parse(message.timestamp),Date.now())).toISOString() : now;
 const requestId = keys.eventKey;
 db.exec('BEGIN IMMEDIATE');
 try {
  db.prepare("INSERT OR IGNORE INTO conversations(id,title,source,created_at,updated_at,starcore_id,channel_id,scope_id) VALUES(?, 'QQ 对话', 'qq-bot', ?, ?, 'qq-bot', 'qq-bot', ?)").run(keys.conversationId,now,now,keys.conversationId);
  const people = new PeopleRepository(db);
  const space = message.conversationType === 'group' ? people.findSpace('qq', account, 'group', message.conversationId) : null;
  const resolved = resolveIdentity(people, { channelId:'qq-bot', accountId:account, senderId:message.senderId, conversationType:message.conversationType, ...(message.conversationType === 'group' ? { groupId:message.conversationId } : {}) });
  const prior = db.prepare("SELECT m.content,p.sender_key,p.account_key,p.space_key FROM messages m JOIN message_provenance p ON p.message_id=m.id WHERE m.conversation_id=? AND m.request_id=? AND m.role='user'").get(keys.conversationId,requestId);
  if (prior && (prior.content !== message.content || prior.sender_key !== message.senderId || prior.account_key !== account || prior.space_key !== (message.conversationType === 'group' ? message.conversationId : null))) throw new Error('QQ_EVENT_CONFLICT');
  if (!prior) {
   const mid=randomUUID();
   db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at,status,request_id) VALUES(?,?,'user',?,?,'complete',?)").run(mid,keys.conversationId,message.content,timestamp,requestId);
   db.prepare("UPDATE message_provenance SET channel_id='qq-bot',provider='qq',conversation_type=?,author_kind='platform_user',provenance_kind='trusted_channel',identity_state='unknown',space_state=?,account_key=?,sender_key=?,space_key=?,event_key=?,observed_at=? WHERE message_id=?").run(message.conversationType,message.conversationType==='group'?'unknown':'not_applicable',account,message.senderId,message.conversationType==='group'?message.conversationId:null,keys.eventKey,timestamp,mid);
   if (resolved.kind === 'resolved') db.prepare("UPDATE message_provenance SET identity_state='known',identity_id=? WHERE message_id=?").run(resolved.identityId,mid);
   if (space) db.prepare("UPDATE message_provenance SET space_state='known',space_id=? WHERE message_id=?").run(space.id,mid);
  }
  if (reply !== undefined && typeof reply === 'string' && reply.trim()) {
   const existing=db.prepare("SELECT content FROM messages WHERE conversation_id=? AND request_id=? AND role='assistant'").get(keys.conversationId,requestId);
   if (existing && existing.content !== reply) throw new Error('QQ_EVENT_CONFLICT');
   if (!existing) {
    const mid=randomUUID(); db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at,status,request_id) VALUES(?,?,'assistant',?,?,'complete',?)").run(mid,keys.conversationId,reply,now,requestId);
    db.prepare("UPDATE message_provenance SET channel_id='qq-bot',provider='qq',conversation_type=?,author_kind='agent',provenance_kind='trusted_channel',identity_state='not_applicable',space_state=?,account_key=?,space_key=?,observed_at=? WHERE message_id=?").run(message.conversationType,message.conversationType==='group'?'unknown':'not_applicable',account,message.conversationType==='group'?message.conversationId:null,now,mid);
    if (space) db.prepare("UPDATE message_provenance SET space_state='known',space_id=? WHERE message_id=?").run(space.id,mid);
   }
  }
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now,keys.conversationId); db.exec('COMMIT');
 } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
