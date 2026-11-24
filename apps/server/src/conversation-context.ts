export type ConversationContextMessage = { role: "system" | "user" | "assistant"; content: string };

/** UTF-8 bytes are a conservative, provider-independent size budget, not a token count. */
export function buildConversationContext(
  history: ConversationContextMessage[],
  current: string,
  budgetBytes = 48_000,
  system: string[] = [],
  recentMessageLimit = 50,
  mode: "turns" | "messages" = "turns",
): ConversationContextMessage[] {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw new Error("INVALID_BUDGET");
  if (!Number.isSafeInteger(recentMessageLimit) || recentMessageLimit < 2) throw new Error("INVALID_RECENT_LIMIT");
  const prefix: ConversationContextMessage[] = system.map((content) => ({ role: "system", content }));
  const cost = (message: ConversationContextMessage) => Buffer.byteLength(message.content, "utf8") + 32;
  const currentMessage: ConversationContextMessage = { role: "user", content: current };
  let size = prefix.reduce((sum, message) => sum + cost(message), cost(currentMessage));
  if (size > budgetBytes) throw new Error("CONTEXT_TOO_LARGE");
  const selected: ConversationContextMessage[] = [];
  const first = Math.max(0, history.length - recentMessageLimit);
  if (mode === "messages") {
    for (let index = history.length - 1; index >= first; index--) {
      const message = history[index]!;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const messageSize = cost(message);
      if (size + messageSize > budgetBytes) continue;
      selected.unshift(message); size += messageSize;
    }
    return [...prefix, ...selected, currentMessage];
  }
  // Web preserves its existing complete adjacent user/assistant turns.
  for (let index = history.length - 1; index - 1 >= first; index -= 2) {
    const user = history[index - 1];
    const assistant = history[index];
    if (user?.role !== "user" || assistant?.role !== "assistant") break;
    const turnSize = cost(user) + cost(assistant);
    if (size + turnSize > budgetBytes) break;
    selected.unshift(user, assistant);
    size += turnSize;
  }
  return [...prefix, ...selected, currentMessage];
}
