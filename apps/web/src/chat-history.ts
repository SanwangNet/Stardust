export type ChatMessage = { id: string; role: "user" | "model"; content: string };
export const chatHistoryKey = "stardust.chat.history.v1";

export function readChatHistory(storage: Pick<Storage, "getItem">): ChatMessage[] {
  const raw = storage.getItem(chatHistoryKey);
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.some((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const value = item as Record<string, unknown>;
    return typeof value.id !== "string" || !value.id || (value.role !== "user" && value.role !== "model") || typeof value.content !== "string";
  })) throw new Error("INVALID_CHAT_HISTORY");
  return data as ChatMessage[];
}

export function appendChatHistory(storage: Pick<Storage, "getItem" | "setItem">, message: ChatMessage): ChatMessage[] {
  const history = readChatHistory(storage);
  if (!history.some((item) => item.id === message.id)) {
    history.push(message);
    storage.setItem(chatHistoryKey, JSON.stringify(history));
  }
  return history;
}
