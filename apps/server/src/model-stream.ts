/** Collect an OpenAI-compatible SSE response without exposing partial content. */
export async function collectModelStream(
  response: Response,
  signal: AbortSignal,
  limit: number,
  invalid: () => Error,
  incomplete: () => Error,
  streamError: (data: string) => Promise<Error>,
): Promise<string> {
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
      const delta = (choice as { delta?: unknown }).delta;
      if (delta == null) continue;
      if (typeof delta !== "object" || Array.isArray(delta)) throw invalid();
      const content = (delta as { content?: unknown }).content;
      if (content == null) continue;
      if (typeof content !== "string") throw invalid();
      text += content;
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
    if (!text.trim()) throw invalid();
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!reachedEnd) cancel();
    try { reader.releaseLock(); } catch { /* Cancellation can still be settling. */ }
  }
}
