import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProject, parseProject } from "../apps/web/dist/flow-project.js";
import { BACKUP_KEY, MIGRATION_KEY, PROJECT_KEY, loadProject } from "../apps/web/dist/flow-project-migration.js";
import { exampleProject as oldProject } from "./flow-project-fixture.mjs";

class MemoryStorage {
  values = new Map();
  fail;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.fail?.(key, value)) throw new Error("quota");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

test("backs up old design verbatim and migrates only once", () => {
  const storage = new MemoryStorage();
  const original = JSON.stringify(oldProject(), null, 2);
  storage.setItem(PROJECT_KEY, original);
  storage.setItem("another-key", "unchanged");
  const first = loadProject(storage);
  assert.equal(first.migrated, true);
  assert.equal(storage.getItem(BACKUP_KEY), original);
  assert.deepEqual(parseProject(JSON.parse(storage.getItem(BACKUP_KEY))), JSON.parse(original));
  assert.deepEqual(first.project, exampleProject());
  assert.equal(storage.getItem(MIGRATION_KEY), "complete");
  assert.equal(storage.getItem("another-key"), "unchanged");
  first.project.boards[0].nodes[0].title = "用户修改";
  const edited = JSON.stringify(first.project);
  storage.setItem(PROJECT_KEY, edited);
  assert.equal(loadProject(storage).serialized, edited);
  assert.equal(storage.getItem(BACKUP_KEY), original);
  const imported = JSON.stringify(oldProject());
  storage.setItem(PROJECT_KEY, imported);
  assert.equal(loadProject(storage).serialized, imported);
});

test("a fresh browser uses the default without creating a spurious backup", () => {
  const storage = new MemoryStorage();
  const loaded = loadProject(storage);
  assert.equal(loaded.serialized, null);
  assert.equal(storage.getItem(BACKUP_KEY), null);
  assert.equal(storage.getItem(MIGRATION_KEY), "complete");
  assert.deepEqual(loaded.project, exampleProject());
});

test("backup, validation and marker failures preserve the source design", () => {
  for (const rejected of [BACKUP_KEY, MIGRATION_KEY, PROJECT_KEY]) {
    const storage = new MemoryStorage(), original = JSON.stringify(oldProject());
    storage.setItem(PROJECT_KEY, original);
    storage.fail = key => key === rejected;
    assert.throws(() => loadProject(storage));
    assert.equal(storage.getItem(PROJECT_KEY), original);
  }
  const invalid = new MemoryStorage();
  invalid.setItem(PROJECT_KEY, '{"boards":"broken"}');
  assert.throws(() => loadProject(invalid));
  assert.equal(invalid.getItem(PROJECT_KEY), '{"boards":"broken"}');
  assert.equal(invalid.getItem(BACKUP_KEY), null);
  const conflict = new MemoryStorage();
  conflict.setItem(PROJECT_KEY, JSON.stringify(oldProject()));
  conflict.setItem(BACKUP_KEY, "other backup");
  assert.throws(() => loadProject(conflict));
  assert.equal(conflict.getItem(BACKUP_KEY), "other backup");
});

test("interrupted migration resumes from the verified backup without replacing later edits", () => {
  const original = JSON.stringify(oldProject());
  const replacement = JSON.stringify(exampleProject());
  for (const current of [original, replacement]) {
    const storage = new MemoryStorage();
    storage.setItem(PROJECT_KEY, current);
    storage.setItem(BACKUP_KEY, original);
    storage.setItem(MIGRATION_KEY, "pending");
    assert.equal(loadProject(storage).serialized, replacement);
    assert.equal(storage.getItem(BACKUP_KEY), original);
  }
  const conflicting = new MemoryStorage();
  conflicting.setItem(PROJECT_KEY, JSON.stringify(oldProject()));
  conflicting.setItem(BACKUP_KEY, original);
  conflicting.setItem(MIGRATION_KEY, "pending");
  const current = conflicting.getItem(PROJECT_KEY);
  assert.throws(() => loadProject(conflicting));
  assert.equal(conflicting.getItem(PROJECT_KEY), current);
});

test("failure to mark completion rolls the active project back to its backup", () => {
  const storage = new MemoryStorage();
  const original = JSON.stringify(oldProject());
  storage.setItem(PROJECT_KEY, original);
  storage.fail = (key, value) => key === MIGRATION_KEY && value === "complete";
  assert.throws(() => loadProject(storage));
  assert.equal(storage.getItem(PROJECT_KEY), original);
  assert.equal(storage.getItem(BACKUP_KEY), original);
  storage.fail = undefined;
  assert.deepEqual(loadProject(storage).project, exampleProject());
});
