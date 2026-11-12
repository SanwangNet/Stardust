import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export type EnvValues = Record<string, string>;
export type ExtensionEnv =
  | { configured: false }
  | { configured: true; values: EnvValues };

// This module lives in apps/server/src or apps/server/dist, not the caller's cwd.
export const projectConfigRoot = fileURLToPath(new URL("../../../", import.meta.url));

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function readEnv(path: string): EnvValues {
  const values: EnvValues = {};
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value !== undefined) Object.defineProperty(values, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return values;
}

/** The supplied root is explicit; it defaults to the project containing this module. */
export function createEnvLoader(configRoot: string = projectConfigRoot) {
  if (!isAbsolute(configRoot)) throw new Error("配置根目录必须是绝对路径");

  function loadCoreEnv(): EnvValues {
    try {
      return readEnv(join(configRoot, ".env"));
    } catch (error) {
      if (isMissing(error)) return {};
      throw new Error("无法读取 Core 环境配置");
    }
  }

  function loadExtensionEnv(extensionId: string): ExtensionEnv {
    // Lowercase IDs are stable across case-sensitive and case-insensitive file systems.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(extensionId) || extensionId.length > 64
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(extensionId)) {
      throw new Error("无效的扩展 ID");
    }
    try {
      const root = realpathSync(configRoot);
      const envPath = join(root, "env");
      if (lstatSync(envPath).isSymbolicLink()) throw new Error();
      const envRoot = realpathSync(envPath);
      if (!isWithin(root, envRoot)) throw new Error();
      const extensionPath = join(envRoot, extensionId);
      if (lstatSync(extensionPath).isSymbolicLink()) throw new Error();
      const extensionRoot = realpathSync(extensionPath);
      if (!isWithin(envRoot, extensionRoot)) throw new Error();
      const filePath = join(extensionRoot, ".env");
      if (lstatSync(filePath).isSymbolicLink()) throw new Error();
      const file = realpathSync(filePath);
      if (!isWithin(extensionRoot, file)) throw new Error();
      return { configured: true, values: readEnv(file) };
    } catch (error) {
      if (isMissing(error)) return { configured: false };
      throw new Error("无法读取扩展环境配置");
    }
  }

  return { loadCoreEnv, loadExtensionEnv };
}

export const { loadCoreEnv, loadExtensionEnv } = createEnvLoader();


