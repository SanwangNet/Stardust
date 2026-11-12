import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { projectConfigRoot, createEnvLoader } from "./env.js";

const keyName = "STARDUST_MODEL_API_KEY";

function encoded(value: string): string {
  if (value.length > 4096 || /[^\x21-\x7e]/.test(value)) throw new Error("INVALID_KEY");
  for (const candidate of [value, `'${value}'`, `"${value}"`]) {
    if (parseEnv(`${keyName}=${candidate}`)[keyName] === value) return candidate;
  }
  throw new Error("INVALID_KEY");
}

// Replace only the selected variable, preserving other definitions and comments, including multiline values.
function replaceKey(source: string, value: string): string {
  const replacement = value ? encoded(value) : "";
  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const output: string[] = [];
  let written = false;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]!;
    const match = /^(\uFEFF?[ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([^\r\n]*)/.exec(first);
    if (!match) { output.push(first); continue; }
    const name = match[2]!;
    const raw = match[3]!;
    const quote = raw[0];
    let last = i;
    let trailing = raw;
    if (quote === '"' || quote === "'" || quote === "`") {
      let offset = raw.indexOf(quote, 1);
      while (offset < 0 && last + 1 < lines.length) {
        last++;
        offset = lines[last]!.indexOf(quote);
      }
      if (offset < 0) throw new Error("INVALID_ENV");
      trailing = (last === i ? raw : lines[last]!).slice(offset + 1).replace(/[\r\n]+$/, "");
    }
    if (name !== keyName) {
      output.push(...lines.slice(i, last + 1));
      i = last;
      continue;
    }
    const hash = trailing.indexOf("#");
    const comment = hash < 0 ? "" : trailing.slice(hash);
    const finalLine = lines[last]!;
    const ending = /(?:\r\n|\n|\r)$/.exec(finalLine)?.[0] ?? "";
    // Node's dotenv parser treats a BOM attached to a variable name as part of that name.
    // Keep the BOM on its own line so the rewritten key and following variables parse normally.
    const bom = match[1]?.startsWith("\uFEFF") ? `\uFEFF${eol}` : "";
    const prefix = match[1]?.replace(/^\uFEFF/, "") ?? "";
    if (value && !written) {
      output.push(`${bom}${prefix}${keyName}=${replacement}${comment ? ` ${comment}` : ""}${ending}`);
      written = true;
    } else if (comment) output.push(`${bom}${comment}${ending}`);
    else if (bom) output.push(bom);
    i = last;
  }
  let result = output.join("");
  if (value && !written) {
    if (result && !/[\r\n]$/.test(result)) result += eol;
    result += `${keyName}=${replacement}${eol}`;
  }
  return result;
}

export function createSecretStore(root: string = projectConfigRoot, processEnv: NodeJS.ProcessEnv = process.env) {
  if (!isAbsolute(root)) throw new Error("INVALID_ROOT");
  const path = join(root, ".env");
  function getKey(): { key: string; fileKey: string; source: "process" | "file" | "none"; fileConfigured: boolean } {
    const values = createEnvLoader(root).loadCoreEnv();
    const fileKey = values[keyName] ?? values[`\uFEFF${keyName}`] ?? "";
    const fromProcess = processEnv[keyName];
    const key = fromProcess ?? fileKey;
    return { key, fileKey, source: fromProcess !== undefined ? "process" : fileKey ? "file" : "none", fileConfigured: Boolean(fileKey) };
  }
  function saveKey(value: string): void {
    if (typeof value !== "string") throw new Error("INVALID_KEY");
    if (value) encoded(value);
    let source: string;
    try { source = fs.readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") source = "";
      else throw new Error("SECRET_SAVE_FAILED");
    }
    let result: string;
    try { result = replaceKey(source, value); }
    catch (error) { if (error instanceof Error && error.message === "INVALID_KEY") throw error; throw new Error("SECRET_SAVE_FAILED"); }
    if (result === source) return;
    const temporary = join(root, `.env.model.${randomUUID()}.tmp`);
    let fd: number | undefined;
    let created = false;
    try {
      fd = fs.openSync(temporary, "wx", 0o600); created = true;
      fs.writeFileSync(fd, result, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, path); created = false;
    } catch { throw new Error("SECRET_SAVE_FAILED"); }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (created) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }
  function validateKey(value: string): void { if (value) encoded(value); }
  return { getKey, saveKey, validateKey };
}
