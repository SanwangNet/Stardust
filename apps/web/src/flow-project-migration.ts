import { exampleProject, parseProject, type FlowDesignProject } from "./flow-project.js";
import { repairProject } from "./flow-project-repair.js";
import { simplifyProject } from "./flow-project-simplify.js";

export const PROJECT_KEY = "stardust.flow-project.v1";
export const BACKUP_KEY = "stardust.flow-project.v1.m5-c0.backup";
export const MIGRATION_KEY = "stardust.flow-project.v1.m5-c0.migration";
export const REPAIR_BACKUP_KEY = "stardust.flow-project.v1.m5-c0-relations.backup";
export const REPAIR_MARKER_KEY = "stardust.flow-project.v1.m5-c0-relations.migration";
export const SIMPLIFY_BACKUP_KEY = "stardust.flow-project.v1.qq-context.backup";
export const SIMPLIFY_MARKER_KEY = "stardust.flow-project.v1.qq-context.migration";

/** Migrate once. Each write is verified and an interrupted migration can be resumed. */
export function loadProject(storage: Storage): { project: FlowDesignProject; serialized: string | null; migrated: boolean } {
  const repaired = applyUpdate(storage, loadOriginalProject(storage), REPAIR_MARKER_KEY, REPAIR_BACKUP_KEY, repairProject);
  return applyUpdate(storage, repaired, SIMPLIFY_MARKER_KEY, SIMPLIFY_BACKUP_KEY, simplifyProject);
}

function applyUpdate(
  storage: Storage,
  loaded: { project: FlowDesignProject; serialized: string | null; migrated: boolean },
  markerKey: string,
  backupKey: string,
  update: (project: FlowDesignProject) => { project: FlowDesignProject; changed: boolean },
): { project: FlowDesignProject; serialized: string | null; migrated: boolean } {
  const marker = storage.getItem(markerKey);
  if (marker === "complete") return loaded;
  if (marker !== null && marker !== "pending") throw new Error("画板修复标记无效。");
  const repaired = update(loaded.project);
  const current = loaded.serialized;
  const backup = storage.getItem(backupKey);

  if (marker === "pending") {
    if (backup === null || current === null) throw new Error("画板修复备份缺失。");
    parseProject(JSON.parse(backup));
    if (current !== backup && repaired.changed) throw new Error("画板在修复期间发生了变化。");
  }
  if (!repaired.changed || current === null) {
    storage.setItem(markerKey, "complete");
    if (storage.getItem(markerKey) !== "complete") throw new Error("无法记录画板修复状态。");
    return loaded;
  }
  if (marker === null) {
    if (backup !== null && backup !== current) throw new Error("已有不同的画板修复备份。");
    if (backup === null) storage.setItem(backupKey, current);
    if (storage.getItem(backupKey) !== current) throw new Error("画板修复备份校验失败。");
    storage.setItem(markerKey, "pending");
    if (storage.getItem(markerKey) !== "pending") throw new Error("无法记录画板修复状态。");
  }
  if (storage.getItem(PROJECT_KEY) !== current) throw new Error("画板在修复期间发生了变化。");
  const serialized = JSON.stringify(repaired.project);
  try {
    storage.setItem(PROJECT_KEY, serialized);
    if (storage.getItem(PROJECT_KEY) !== serialized) throw new Error("画板修复写入校验失败。");
    storage.setItem(markerKey, "complete");
    if (storage.getItem(markerKey) !== "complete") throw new Error("无法记录画板修复完成状态。");
  } catch (error) {
    if (storage.getItem(PROJECT_KEY) === serialized) {
      try { storage.setItem(PROJECT_KEY, current); } catch { /* The verified backup remains available. */ }
    }
    throw error;
  }
  return { project: repaired.project, serialized, migrated: true };
}

function loadOriginalProject(storage: Storage): { project: FlowDesignProject; serialized: string | null; migrated: boolean } {
  const replacement = JSON.stringify(exampleProject());
  const marker = storage.getItem(MIGRATION_KEY);
  let current = storage.getItem(PROJECT_KEY);
  if (marker === "complete") {
    return { project: current === null ? exampleProject() : parseProject(JSON.parse(current)), serialized: current, migrated: false };
  }
  if (marker !== null && marker !== "pending") throw new Error("替换标记无效。");
  if (current === null && marker === null) {
    storage.setItem(MIGRATION_KEY, "complete");
    if (storage.getItem(MIGRATION_KEY) !== "complete") throw new Error("无法记录替换状态。");
    return { project: exampleProject(), serialized: null, migrated: false };
  }

  const backup = storage.getItem(BACKUP_KEY);
  if (marker === "pending") {
    if (backup === null || (current !== backup && current !== replacement)) throw new Error("检测到未完成的替换和不同的当前工程。");
    parseProject(JSON.parse(backup));
  } else {
    if (current === null) throw new Error("无法读取原工程。");
    parseProject(JSON.parse(current));
    if (backup !== null && backup !== current) throw new Error("已有不同的 M5-C0 备份。");
    if (backup === null) storage.setItem(BACKUP_KEY, current);
    if (storage.getItem(BACKUP_KEY) !== current) throw new Error("原工程备份校验失败。");
    storage.setItem(MIGRATION_KEY, "pending");
    if (storage.getItem(MIGRATION_KEY) !== "pending") throw new Error("无法记录替换状态。");
  }
  // Check the source again before replacing it if another tab changed storage.
  if (storage.getItem(PROJECT_KEY) !== current) throw new Error("原工程在替换期间发生了变化。");
  try {
    if (current !== replacement) storage.setItem(PROJECT_KEY, replacement);
    if (storage.getItem(PROJECT_KEY) !== replacement) throw new Error("新工程写入校验失败。");
    storage.setItem(MIGRATION_KEY, "complete");
    if (storage.getItem(MIGRATION_KEY) !== "complete") throw new Error("无法记录替换完成状态。");
  } catch (error) {
    // Do not overwrite changes from another tab while attempting recovery.
    if (current !== replacement && storage.getItem(PROJECT_KEY) === replacement) {
      try { storage.setItem(PROJECT_KEY, current!); } catch { /* The verified backup remains available. */ }
    }
    throw error;
  }
  current = replacement;
  return { project: parseProject(JSON.parse(current)), serialized: current, migrated: true };
}
