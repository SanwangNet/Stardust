import type { DatabaseSync } from "node:sqlite";

export type HistoryResult = { conversationId: string; role: string; content: string; createdAt: string };
export type HistoryEvidence = { sequence: number; start: number };

export function searchHistory(db: DatabaseSync, owner: string, input: unknown, onResult?: (evidence: HistoryEvidence) => void): HistoryResult[] {
  if (owner !== "web:default" || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_SEARCH");
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["keywords", "limit"].includes(key)) || !Array.isArray(fields.keywords) || fields.keywords.length < 1 || fields.keywords.length > 8 || fields.keywords.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 32 || /[\x00-\x1f\x7f]/.test(item)) || (fields.limit !== undefined && (!Number.isInteger(fields.limit) || Number(fields.limit) < 1 || Number(fields.limit) > 10))) throw new Error("INVALID_SEARCH");
  const words = [...new Set((fields.keywords as string[]).map((word) => word.trim().toLowerCase()))];
  const patterns = words.map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`);
  const conditions = words.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ");
  const rows = db.prepare(`SELECT m.conversation_id AS conversationId, m.role, m.content, m.created_at AS createdAt, m.sequence FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_id = 'web' AND c.scope_id = ? AND m.status = 'complete' AND (${conditions}) ORDER BY m.sequence DESC LIMIT 500`).all(owner, ...patterns) as unknown as (HistoryResult & { sequence: number })[];
  const ranked = rows.map((row) => {
    const text = row.content.toLowerCase();
    const hits = words.filter((word) => text.includes(word));
    return { row, hits, score: hits.length * 100 + hits.reduce((sum, word) => sum + Math.min(word.length, 16), 0) };
  }).filter((item) => item.hits.length).sort((a, b) => b.score - a.score || b.row.sequence - a.row.sequence);
  const result: HistoryResult[] = [];
  let bytes = 0;
  for (const { row, hits } of ranked) {
    const position = row.content.toLowerCase().indexOf(hits[0]!);
    const start = Math.max(0, position - 160);
    const content = `${start ? "…" : ""}${row.content.slice(start, start + 480)}${start + 480 < row.content.length ? "…" : ""}`;
    const item = { conversationId: row.conversationId, role: row.role, content, createdAt: row.createdAt };
    const next = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes + next > 8000) break;
    result.push(item); bytes += next;
    onResult?.({ sequence: row.sequence, start });
    if (result.length >= Number(fields.limit ?? 10)) break;
  }
  return result;
}
