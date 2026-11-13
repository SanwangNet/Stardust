/** Collect an OpenAI-compatible SSE response without exposing partial content. */
export async function collectModelTurn(
  response: Response,
  signal: AbortSignal,
  limit: number,
  invalid: () => Error,
  incomplete: () => Error,
  streamError: (data: string) => Promise<Error>,
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }> {
  if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let skipLF = false;
  let eventType = "";
  let dataLines: string[] = [];
  let size = 0;
  let text = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let done = false;
  let reachedEnd = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();

  async function dispatch(): Promise<void> {
    const data = dataLines.join("\n");
    const kind = eventType;
    eventType = "";
    dataLines = [];
    if (!data) return;
    if (kind === "error") throw await streamError(data);
    if (kind === "ping") return;
    if (data === "[DONE]") { done = true; return; }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { throw invalid(); }
    if (payload && typeof payload === "object" && "error" in payload && (payload as { error: unknown }).error != null) throw await streamError(data);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { choices?: unknown }).choices)) throw invalid();
    for (const choice of (payload as { choices: unknown[] }).choices) {
      if (!choice || typeof choice !== "object") throw invalid();
      const choiceIndex = (choice as { index?: unknown }).index;
      if (choiceIndex !== undefined && (!Number.isInteger(choiceIndex) || (choiceIndex as number) < 0)) throw invalid();
      if (choiceIndex !== undefined && choiceIndex !== 0) continue;
      const delta = (choice as { delta?: unknown }).delta;
      if (delta == null) continue;
      if (typeof delta !== "object" || Array.isArray(delta)) throw invalid();
      const content = (delta as { content?: unknown }).content;
      if (content != null) { if (typeof content !== "string") throw invalid(); text += content; }
      const fragments = (delta as { tool_calls?: unknown }).tool_calls;
      if (fragments != null) {
        if (!Array.isArray(fragments) || fragments.length > 8) throw invalid();
        for (const fragment of fragments) {
          if (!fragment || typeof fragment !== "object") throw invalid();
          const part = fragment as { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
          if (!Number.isInteger(part.index) || (part.index as number) < 0 || (part.index as number) >= 8 || (part.type !== undefined && part.type !== "function")) throw invalid();
          const entry = calls.get(part.index as number) ?? { id: "", name: "", arguments: "" };
          if (part.id !== undefined) { if (typeof part.id !== "string") throw invalid(); entry.id += part.id; }
          if (part.function !== undefined) {
            if (!part.function || typeof part.function !== "object") throw invalid();
            if (part.function.name !== undefined) { if (typeof part.function.name !== "string") throw invalid(); entry.name += part.function.name; }
            if (part.function.arguments !== undefined) { if (typeof part.function.arguments !== "string") throw invalid(); entry.arguments += part.function.arguments; }
          }
          if (entry.id.length > 256 || entry.name.length > 128 || entry.arguments.length > 32768) throw invalid();
          calls.set(part.index as number, entry);
        }
      }
    }
  }

  async function processLine(value: string): Promise<void> {
    if (value === "") { await dispatch(); return; }
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let fieldValue = separator < 0 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "data") dataLines.push(fieldValue);
    else if (field === "event") eventType = fieldValue;
  }

  async function consume(value: string): Promise<void> {
    let start = 0;
    if (skipLF && value.length) { if (value[0] === "\n") start = 1; skipLF = false; }
    for (let i = start; i < value.length; i++) {
      const char = value[i];
      if (char !== "\r" && char !== "\n") continue;
      line += value.slice(start, i);
      await processLine(line);
      line = "";
      if (done) return;
      if (char === "\r") {
        if (i + 1 < value.length && value[i + 1] === "\n") i++;
        else if (i + 1 === value.length) skipLF = true;
      }
      start = i + 1;
    }
    line += value.slice(start);
  }

  try {
    while (!done) {
      const item = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (item.done) { reachedEnd = true; break; }
      size += item.value.byteLength;
      if (size > limit) throw invalid();
      let decoded: string;
      try { decoded = decoder.decode(item.value, { stream: true }); } catch { throw invalid(); }
      await consume(decoded);
    }
    if (signal.aborted) throw signal.reason;
    if (!done) {
      let tail: string;
      try { tail = decoder.decode(); } catch { throw invalid(); }
      await consume(tail);
      if (line) await processLine(line);
      if (!done && dataLines.length) await dispatch();
    }
    if (!done) throw incomplete();
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
    if ((!text.trim() && !toolCalls.length) || toolCalls.some((call) => !call.id || !call.name || !call.arguments)) throw invalid();
    return { content: text, toolCalls };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!reachedEnd) cancel();
    try { reader.releaseLock(); } catch { /* Cancellation can still be settling. */ }
  }
}

export async function collectModelStream(response: Response, signal: AbortSignal, limit: number, invalid: () => Error, incomplete: () => Error, streamError: (data: string) => Promise<Error>): Promise<string> {
  const result = await collectModelTurn(response, signal, limit, invalid, incomplete, streamError);
  if (!result.content.trim() || result.toolCalls.length) throw invalid();
  return result.content;
}
