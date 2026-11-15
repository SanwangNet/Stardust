export type ModelCategory = "chat" | "other";

// Providers do not share a model-list capability schema. Only interpret explicit,
// bounded fields, then fall back to naming signals; unknown models remain selectable.
export function classifyModel(id: string, entry: unknown): ModelCategory {
  if (/(?:^|[\/_.-])compact(?=$|[\/_.-]|\d)/i.test(id)) return "other";
  const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  const capabilities = record.capabilities && typeof record.capabilities === "object" && !Array.isArray(record.capabilities) ? record.capabilities as Record<string, unknown> : {};
  if (capabilities.chat_completions === true || capabilities.chat === true) return "chat";
  if (capabilities.chat_completions === false || capabilities.chat === false) return "other";
  const fields = [record.type, record.task, record.pipeline_tag, record.pipelineTag, record.mode].filter((value): value is string => typeof value === "string" && value.length <= 128).map((value) => value.toLowerCase());
  const chatType = /^(?:chat|chat-completion|chat_completion|conversational|text-generation)$/;
  const otherType = /^(?:embedding|embeddings|image|audio|speech|transcription|translation|rerank|moderation|classification)$/;
  if (fields.some((value) => chatType.test(value))) return "chat";
  if (fields.some((value) => otherType.test(value))) return "other";
  const name = id.toLowerCase();
  if (/(?:^|[\/_.-])(?:embedding|embeddings|embed|rerank|reranker|moderation|whisper|transcribe|transcription|tts|stt|speech|audio|image|img|vision-encoder|clip|dall[.-]?e|diffusion|asr|ocr)(?=$|[\/_.-]|\d)/.test(name)) return "other";
  if (/(?:^|[\/_.-])(?:chat|instruct|assistant)(?=$|[\/_.-]|\d)/.test(name) || /(?:^|[\/_.-])gpt(?:[\d.-]|$)/.test(name)) return "chat";
  return "other";
}
