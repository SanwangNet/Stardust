// Fallback for older servers that return IDs without capability metadata.
export function isCompactModel(id: string): boolean {
  return /(?:^|[\/_.-])compact(?=$|[\/_.-]|\d)/i.test(id);
}
export function classifyModelName(id: string): "chat" | "other" {
  if (isCompactModel(id)) return "other";
  const name = id.toLowerCase();
  if (/(?:^|[\/_.-])(?:embedding|embeddings|embed|rerank|reranker|moderation|whisper|transcribe|transcription|tts|stt|speech|audio|image|img|vision-encoder|clip|dall[.-]?e|diffusion|asr|ocr)(?=$|[\/_.-]|\d)/.test(name)) return "other";
  if (/(?:^|[\/_.-])(?:chat|instruct|assistant)(?=$|[\/_.-]|\d)/.test(name) || /(?:^|[\/_.-])gpt(?:[\d.-]|$)/.test(name)) return "chat";
  return "other";
}
