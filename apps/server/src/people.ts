import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Provider namespaces must distinguish independent platform applications/accounts. */
export type IdentityScope = { kind: "account" } | { kind: "space"; spaceId: string };
export type Observation = { observedAt: string; source: string; sourceEventId?: string | null };
export type SpaceObservation = Observation & { providerId: string; accountId: string; spaceType: string; externalId: string; displayName?: string | null };
export type IdentityObservation = Observation & { providerId: string; accountId: string; identityType: string; scope: IdentityScope; externalId: string; displayName?: string | null };
export type MembershipObservation = Observation & { spaceId: string; identityId: string; displayName?: string | null; role?: string | null };
export type SpaceMemberObservation = {
  space: SpaceObservation;
  identity: Omit<IdentityObservation, "providerId" | "accountId" | "scope"> & { scopeKind: "account" | "space" };
  membership: Omit<MembershipObservation, "spaceId" | "identityId">;
};
export type Person = { id: string; displayName: string | null; displayNameObservedAt: string | null; displayNameSource: string | null; manualName: string | null; note: string | null; version: number; mergedIntoId: string | null; mergedAt: string | null; mergeAuditId: string | null; status: "provisional" | "confirmed"; createdAt: string; updatedAt: string };
export type Identity = { id: string; personId: string; providerId: string; accountId: string; identityType: string; scopeKind: "account" | "space"; scopeSpaceId: string | null; externalId: string; displayName: string | null; displayNameObservedAt: string | null; displayNameSource: string | null; linkMethod: "observed" | "manual_confirmation" | "platform_verified"; firstSeenAt: string; lastSeenAt: string; observationSource: string; sourceEventId: string | null; createdAt: string; updatedAt: string };
export type Space = { id: string; providerId: string; accountId: string; spaceType: string; externalId: string; displayName: string | null; displayNameObservedAt: string | null; displayNameSource: string | null; firstSeenAt: string; lastSeenAt: string; observationSource: string; sourceEventId: string | null; createdAt: string; updatedAt: string };
export type Membership = { id: string; spaceId: string; identityId: string; displayName: string | null; displayNameObservedAt: string | null; displayNameSource: string | null; role: string | null; roleObservedAt: string | null; roleSource: string | null; firstSeenAt: string; lastSeenAt: string; observedAt: string; observationSource: string; sourceEventId: string | null; createdAt: string; updatedAt: string };

/** Additive migration on the existing conversation DB; failures leave version and old data untouched. */
export function migratePeople(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 6 || version === 7 || version === 8 || version === 9 || version === 10 || version === 11) { db.exec("COMMIT"); return; }
    if (version !== 5) throw new Error("UNSUPPORTED_SCHEMA");
    db.exec(`
      CREATE TABLE people (
        id TEXT PRIMARY KEY, display_name TEXT, display_name_observed_at TEXT, display_name_source TEXT, status TEXT NOT NULL CHECK(status IN ('provisional','confirmed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_id TEXT NOT NULL, space_type TEXT NOT NULL, external_id TEXT NOT NULL,
        display_name TEXT, display_name_observed_at TEXT, display_name_source TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, observation_source TEXT NOT NULL, source_event_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(provider_id, account_id, space_type, external_id), UNIQUE(id, provider_id, account_id), CHECK(first_seen_at <= last_seen_at)
      );
      CREATE TABLE identities (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
        provider_id TEXT NOT NULL, account_id TEXT NOT NULL, identity_type TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('account','space')), scope_space_id TEXT,
        external_id TEXT NOT NULL, display_name TEXT, display_name_observed_at TEXT, display_name_source TEXT,
        link_method TEXT NOT NULL CHECK(link_method IN ('observed','manual_confirmation','platform_verified')),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, observation_source TEXT NOT NULL, source_event_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(id, provider_id, account_id),
        FOREIGN KEY(scope_space_id, provider_id, account_id) REFERENCES spaces(id, provider_id, account_id) ON DELETE RESTRICT,
        CHECK((scope_kind = 'account' AND scope_space_id IS NULL) OR (scope_kind = 'space' AND scope_space_id IS NOT NULL)),
        CHECK(first_seen_at <= last_seen_at)
      );
      CREATE UNIQUE INDEX identities_external_scope ON identities(provider_id, account_id, identity_type, scope_kind, ifnull(scope_space_id,''), external_id);
      CREATE INDEX identities_person ON identities(person_id, id);
      CREATE TABLE memberships (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, identity_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
        display_name TEXT, display_name_observed_at TEXT, display_name_source TEXT, role TEXT, role_observed_at TEXT, role_source TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, observed_at TEXT NOT NULL, observation_source TEXT NOT NULL, source_event_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(space_id, provider_id, account_id) REFERENCES spaces(id, provider_id, account_id) ON DELETE CASCADE,
        FOREIGN KEY(identity_id, provider_id, account_id) REFERENCES identities(id, provider_id, account_id) ON DELETE CASCADE,
        UNIQUE(space_id, identity_id), CHECK(first_seen_at <= last_seen_at), CHECK(observed_at = last_seen_at)
      );
      CREATE INDEX memberships_identity ON memberships(identity_id, space_id);
      CREATE INDEX memberships_space_recent ON memberships(space_id, last_seen_at DESC, id);
      CREATE TRIGGER memberships_scope_insert BEFORE INSERT ON memberships
        WHEN EXISTS (SELECT 1 FROM identities WHERE id = NEW.identity_id AND scope_kind = 'space' AND scope_space_id != NEW.space_id)
        BEGIN SELECT RAISE(ABORT, 'MEMBERSHIP_SCOPE_MISMATCH'); END;
      CREATE TRIGGER memberships_scope_update BEFORE UPDATE OF identity_id, space_id ON memberships
        WHEN EXISTS (SELECT 1 FROM identities WHERE id = NEW.identity_id AND scope_kind = 'space' AND scope_space_id != NEW.space_id)
        BEGIN SELECT RAISE(ABORT, 'MEMBERSHIP_SCOPE_MISMATCH'); END;
      CREATE TRIGGER identity_scope_update BEFORE UPDATE OF scope_kind, scope_space_id ON identities
        WHEN NEW.scope_kind = 'space' AND EXISTS (SELECT 1 FROM memberships WHERE identity_id = OLD.id AND space_id != NEW.scope_space_id)
        BEGIN SELECT RAISE(ABORT, 'MEMBERSHIP_SCOPE_MISMATCH'); END;
      PRAGMA user_version = 6;
    `);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

/** Separate additive migration preserves all v6 observations and platform keys. */
export function migratePeopleManagement(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 7 || version === 8 || version === 9 || version === 10 || version === 11) { db.exec("COMMIT"); return; }
    if (version !== 6) throw new Error("UNSUPPORTED_SCHEMA");
    db.exec(`ALTER TABLE people ADD COLUMN manual_name TEXT;
      ALTER TABLE people ADD COLUMN note TEXT;
      ALTER TABLE people ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0);
      ALTER TABLE identities ADD COLUMN link_version INTEGER NOT NULL DEFAULT 0 CHECK(link_version>=0);
      UPDATE people SET manual_name=display_name WHERE display_name_source='manual' AND display_name IS NOT NULL;
      CREATE TABLE people_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL, actor TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        source_person_id TEXT, target_person_id TEXT, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        reason TEXT, created_at TEXT NOT NULL, result TEXT NOT NULL, undo_of TEXT UNIQUE REFERENCES people_audit(id)
      );
      CREATE INDEX people_audit_source ON people_audit(source_person_id,created_at DESC,id);
      CREATE INDEX people_audit_target ON people_audit(target_person_id,created_at DESC,id);
      CREATE INDEX people_audit_object ON people_audit(target_type,target_id,created_at DESC,id);
      CREATE TRIGGER people_audit_no_update BEFORE UPDATE ON people_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
      CREATE TRIGGER people_audit_no_delete BEFORE DELETE ON people_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
      PRAGMA user_version=7;`);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

/** Preserve merged records and prevent identities from being attached to them. */
export function migratePeopleMerge(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 8 || version === 9 || version === 10 || version === 11) { db.exec("COMMIT"); return; }
    if (version !== 7) throw new Error("UNSUPPORTED_SCHEMA");
    db.exec(`ALTER TABLE people ADD COLUMN merged_into_id TEXT REFERENCES people(id) ON DELETE RESTRICT CHECK(merged_into_id IS NULL OR merged_into_id != id);
      ALTER TABLE people ADD COLUMN merged_at TEXT;
      ALTER TABLE people ADD COLUMN merge_audit_id TEXT;
      CREATE INDEX people_merged_into ON people(merged_into_id,id);
      CREATE TRIGGER identity_merged_insert BEFORE INSERT ON identities WHEN EXISTS(SELECT 1 FROM people WHERE id=NEW.person_id AND merged_into_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'PERSON_MERGED'); END;
      CREATE TRIGGER identity_merged_update BEFORE UPDATE OF person_id ON identities WHEN EXISTS(SELECT 1 FROM people WHERE id=NEW.person_id AND merged_into_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'PERSON_MERGED'); END;
      CREATE TRIGGER people_merge_guard BEFORE UPDATE OF merged_into_id ON people WHEN NEW.merged_into_id IS NOT NULL AND (EXISTS(SELECT 1 FROM identities WHERE person_id=NEW.id) OR EXISTS(SELECT 1 FROM people WHERE id=NEW.merged_into_id AND merged_into_id IS NOT NULL) OR EXISTS(SELECT 1 FROM people WHERE merged_into_id=NEW.id)) BEGIN SELECT RAISE(ABORT,'INVALID_MERGE'); END;
      PRAGMA user_version=8;`);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

const personCols = "id, display_name AS displayName, display_name_observed_at AS displayNameObservedAt, display_name_source AS displayNameSource, manual_name AS manualName, note, version, merged_into_id AS mergedIntoId, merged_at AS mergedAt, merge_audit_id AS mergeAuditId, status, created_at AS createdAt, updated_at AS updatedAt";
const identityCols = "id, person_id AS personId, provider_id AS providerId, account_id AS accountId, identity_type AS identityType, scope_kind AS scopeKind, scope_space_id AS scopeSpaceId, external_id AS externalId, display_name AS displayName, display_name_observed_at AS displayNameObservedAt, display_name_source AS displayNameSource, link_method AS linkMethod, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, observation_source AS observationSource, source_event_id AS sourceEventId, created_at AS createdAt, updated_at AS updatedAt";
const spaceCols = "id, provider_id AS providerId, account_id AS accountId, space_type AS spaceType, external_id AS externalId, display_name AS displayName, display_name_observed_at AS displayNameObservedAt, display_name_source AS displayNameSource, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, observation_source AS observationSource, source_event_id AS sourceEventId, created_at AS createdAt, updated_at AS updatedAt";
const memberCols = "id, space_id AS spaceId, identity_id AS identityId, display_name AS displayName, display_name_observed_at AS displayNameObservedAt, display_name_source AS displayNameSource, role, role_observed_at AS roleObservedAt, role_source AS roleSource, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, observed_at AS observedAt, observation_source AS observationSource, source_event_id AS sourceEventId, created_at AS createdAt, updated_at AS updatedAt";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("INVALID_INPUT");
}
function text(value: unknown, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("INVALID_INPUT");
  return value;
}
function id(value: unknown): string { if (typeof value !== "string" || !uuid.test(value)) throw new Error("INVALID_INPUT"); return value; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new Error("INVALID_INPUT");
  const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error("INVALID_INPUT");
  const result = new Date(n).toISOString();
  if (result.slice(0, 19) !== value.slice(0, 19)) throw new Error("INVALID_INPUT");
  return result;
}
function key(value: unknown): string { const result = text(value, 64)!; if (!/^[a-z][a-z0-9_-]*$/.test(result)) throw new Error("INVALID_INPUT"); return result; }
function observe(value: Record<string, unknown>) { return { at: timestamp(value.observedAt), source: key(value.source), event: text(value.sourceEventId, 512, true) }; }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("INVALID_INPUT"); return value as number; }
function noteText(value: unknown, max: number, required = false): string | null {
  if (value === null || value === "") { if (required) throw new Error("INVALID_INPUT"); return null; }
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("INVALID_INPUT");
  return value.trim();
}

/** No model access or automatic identity linking; callers are trusted server adapters. */
export class PeopleRepository {
  constructor(private readonly db: DatabaseSync, private readonly beforeCommit?: () => void) {}
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.beforeCommit?.(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  createPerson(input: { displayName?: string | null; status?: Person["status"] } = {}): Person {
    record(input, ["displayName", "status"]); const name = text(input.displayName, 512, true), status = input.status ?? "provisional";
    if (status !== "provisional" && status !== "confirmed") throw new Error("INVALID_INPUT");
    return this.transaction(() => this.insertPerson(name, status));
  }
  private insertPerson(name: string | null, status: Person["status"], provenance?: { at: string; source: string }): Person {
    const personId = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO people(id,display_name,display_name_observed_at,display_name_source,status,created_at,updated_at,manual_name) VALUES(?,?,?,?,?,?,?,?)").run(personId, name, name ? provenance?.at ?? now : null, name ? provenance?.source ?? "manual" : null, status, now, now, name && !provenance ? name : null);
    return this.getPerson(personId)!;
  }
  getPerson(personId: string): Person | null { const row = this.db.prepare(`SELECT ${personCols} FROM people WHERE id=?`).get(id(personId)); return row ? row as unknown as Person : null; }
  private activePerson(personId: string): Person { const person = this.getPerson(personId); if (!person) throw new Error("NOT_FOUND"); if (person.mergedIntoId) throw new Error("CONFLICT"); return person; }
  listPersons(): Person[] { return this.db.prepare(`SELECT ${personCols} FROM people ORDER BY created_at,id`).all() as unknown as Person[]; }

  private identityInput(input: IdentityObservation) {
    record(input, ["providerId", "accountId", "identityType", "scope", "externalId", "displayName", "observedAt", "source", "sourceEventId"]);
    const provider = key(input.providerId), account = text(input.accountId, 512)!, type = key(input.identityType), external = text(input.externalId, 1024)!, name = text(input.displayName, 512, true), observation = observe(input);
    record(input.scope, ["kind", "spaceId"]);
    if (input.scope.kind !== "account" && input.scope.kind !== "space") throw new Error("INVALID_INPUT");
    if (input.scope.kind === "account" && Object.hasOwn(input.scope, "spaceId")) throw new Error("INVALID_INPUT");
    const scopeId = input.scope.kind === "space" ? id(input.scope.spaceId) : null;
    return { provider, account, type, external, name, observation, scope: input.scope.kind, scopeId };
  }
  findIdentity(input: Pick<IdentityObservation, "providerId" | "accountId" | "identityType" | "scope" | "externalId">): Identity | null {
    record(input, ["providerId", "accountId", "identityType", "scope", "externalId"]);
    const checked = this.identityInput({ ...input, observedAt: "2000-01-01T00:00:00.000Z", source: "lookup" });
    return this.findCheckedIdentity(checked);
  }
  private findCheckedIdentity(x: ReturnType<PeopleRepository["identityInput"]>): Identity | null {
    const row = this.db.prepare(`SELECT ${identityCols} FROM identities WHERE provider_id=? AND account_id=? AND identity_type=? AND scope_kind=? AND ifnull(scope_space_id,'')=ifnull(?,'') AND external_id=?`).get(x.provider, x.account, x.type, x.scope, x.scopeId, x.external);
    return row ? row as unknown as Identity : null;
  }
  getIdentity(identityId: string): Identity | null {
    const row = this.db.prepare(`SELECT ${identityCols} FROM identities WHERE id=?`).get(id(identityId));
    return row ? row as unknown as Identity : null;
  }
  getPersonIdentities(personId: string): Identity[] {
    if (!this.getPerson(personId)) throw new Error("NOT_FOUND");
    return this.db.prepare(`SELECT ${identityCols} FROM identities WHERE person_id=? ORDER BY created_at,id`).all(personId) as unknown as Identity[];
  }
  /** Observations never choose an existing Person by name or any inferred attribute. */
  observeIdentity(input: IdentityObservation): Identity { return this.transaction(() => this.writeIdentity(input)); }
  /** A trusted caller may link a NEW identity only after explicit confirmation; this does not merge or rebind existing identities. */
  upsertIdentity(input: IdentityObservation, link: { personId: string; method: "manual_confirmation" | "platform_verified" }): Identity {
    record(link, ["personId", "method"]); id(link.personId);
    if (link.method !== "manual_confirmation" && link.method !== "platform_verified") throw new Error("INVALID_INPUT");
    return this.transaction(() => this.writeIdentity(input, link));
  }
  private writeIdentity(input: IdentityObservation, link?: { personId: string; method: "manual_confirmation" | "platform_verified" }): Identity {
    const x = this.identityInput(input), previous = this.findCheckedIdentity(x), now = new Date().toISOString();
    if (x.scopeId) { const space = this.getSpace(x.scopeId); if (!space || space.providerId !== x.provider || space.accountId !== x.account) throw new Error("SCOPE_MISMATCH"); }
    if (previous) {
      if (link && previous.personId !== link.personId) throw new Error("IDENTITY_ALREADY_BOUND");
      this.db.prepare(`UPDATE identities SET first_seen_at=min(first_seen_at,?), last_seen_at=max(last_seen_at,?),
        link_method=CASE WHEN link_method='observed' AND ? IS NOT NULL THEN ? ELSE link_method END,
        observation_source=CASE WHEN ?>last_seen_at THEN ? ELSE observation_source END, source_event_id=CASE WHEN ?>last_seen_at THEN ? ELSE source_event_id END,
        display_name=CASE WHEN ? IS NOT NULL AND (display_name_observed_at IS NULL OR ?>display_name_observed_at) THEN ? ELSE display_name END,
        display_name_source=CASE WHEN ? IS NOT NULL AND (display_name_observed_at IS NULL OR ?>display_name_observed_at) THEN ? ELSE display_name_source END,
        display_name_observed_at=CASE WHEN ? IS NOT NULL AND (display_name_observed_at IS NULL OR ?>display_name_observed_at) THEN ? ELSE display_name_observed_at END,
        updated_at=CASE WHEN ?<first_seen_at OR ?>last_seen_at OR (? IS NOT NULL AND (display_name_observed_at IS NULL OR ?>display_name_observed_at)) OR (link_method='observed' AND ? IS NOT NULL) THEN ? ELSE updated_at END WHERE id=?`).run(
          x.observation.at,x.observation.at,link?.method ?? null,link?.method ?? null,x.observation.at,x.observation.source,x.observation.at,x.observation.event,
          x.name,x.observation.at,x.name,x.name,x.observation.at,x.observation.source,x.name,x.observation.at,x.observation.at,
          x.observation.at,x.observation.at,x.name,x.observation.at,link?.method ?? null,now,previous.id);
      return this.findCheckedIdentity(x)!;
    }
    if (link) this.activePerson(link.personId);
    const person = link ? link.personId : this.insertPerson(x.name, "provisional", x.observation).id, identityId = randomUUID();
    this.db.prepare(`INSERT INTO identities(id,person_id,provider_id,account_id,identity_type,scope_kind,scope_space_id,external_id,display_name,display_name_observed_at,display_name_source,link_method,first_seen_at,last_seen_at,observation_source,source_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      identityId,person,x.provider,x.account,x.type,x.scope,x.scopeId,x.external,x.name,x.name ? x.observation.at : null,x.name ? x.observation.source : null,link?.method ?? "observed",x.observation.at,x.observation.at,x.observation.source,x.observation.event,now,now);
    return this.findCheckedIdentity(x)!;
  }

  upsertSpace(input: SpaceObservation): Space { return this.transaction(() => this.writeSpace(input)); }
  private writeSpace(input: SpaceObservation): Space {
    record(input, ["providerId", "accountId", "spaceType", "externalId", "displayName", "observedAt", "source", "sourceEventId"]);
    const provider = key(input.providerId), account = text(input.accountId,512)!, type = key(input.spaceType), external = text(input.externalId,1024)!, name = text(input.displayName,512,true), o = observe(input), now = new Date().toISOString();
    this.db.prepare(`INSERT INTO spaces(id,provider_id,account_id,space_type,external_id,display_name,display_name_observed_at,display_name_source,first_seen_at,last_seen_at,observation_source,source_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id,account_id,space_type,external_id) DO UPDATE SET
      first_seen_at=min(first_seen_at,excluded.first_seen_at), last_seen_at=max(last_seen_at,excluded.last_seen_at),
      observation_source=CASE WHEN excluded.last_seen_at>last_seen_at THEN excluded.observation_source ELSE observation_source END,
      source_event_id=CASE WHEN excluded.last_seen_at>last_seen_at THEN excluded.source_event_id ELSE source_event_id END,
      display_name=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name ELSE display_name END,
      display_name_source=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name_source ELSE display_name_source END,
      display_name_observed_at=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name_observed_at ELSE display_name_observed_at END,
      updated_at=CASE WHEN excluded.first_seen_at<first_seen_at OR excluded.last_seen_at>last_seen_at OR (excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at)) THEN excluded.updated_at ELSE updated_at END`).run(
        randomUUID(),provider,account,type,external,name,name ? o.at : null,name ? o.source : null,o.at,o.at,o.source,o.event,now,now);
    return this.db.prepare(`SELECT ${spaceCols} FROM spaces WHERE provider_id=? AND account_id=? AND space_type=? AND external_id=?`).get(provider,account,type,external) as unknown as Space;
  }
  getSpace(spaceId: string): Space | null { const row = this.db.prepare(`SELECT ${spaceCols} FROM spaces WHERE id=?`).get(id(spaceId)); return row ? row as unknown as Space : null; }
  findSpace(providerId: string, accountId: string, spaceType: string, externalId: string): Space | null {
    const row = this.db.prepare(`SELECT ${spaceCols} FROM spaces WHERE provider_id=? AND account_id=? AND space_type=? AND external_id=?`).get(providerId, accountId, spaceType, externalId);
    return row ? row as unknown as Space : null;
  }
  getMembership(spaceId: string, identityId: string): Membership | null {
    const row = this.db.prepare(`SELECT ${memberCols} FROM memberships WHERE space_id=? AND identity_id=?`).get(id(spaceId), id(identityId));
    return row ? row as unknown as Membership : null;
  }
  listSpaces(): Space[] { return this.db.prepare(`SELECT ${spaceCols} FROM spaces ORDER BY last_seen_at DESC,id`).all() as unknown as Space[]; }
  deleteSpace(spaceId: string): void { this.transaction(() => { if (!this.db.prepare("DELETE FROM spaces WHERE id=?").run(id(spaceId)).changes) throw new Error("NOT_FOUND"); }); }

  upsertMembership(input: MembershipObservation): Membership { return this.transaction(() => this.writeMembership(input)); }
  observeMembership(input: MembershipObservation): Membership { return this.upsertMembership(input); }
  /** Atomically observe a space, its identity and their relationship; no partial Person remains on failure. */
  observeSpaceMember(input: SpaceMemberObservation): { space: Space; identity: Identity; membership: Membership } {
    record(input, ["space", "identity", "membership"]);
    record(input.identity, ["identityType", "scopeKind", "externalId", "displayName", "observedAt", "source", "sourceEventId"]);
    record(input.membership, ["displayName", "role", "observedAt", "source", "sourceEventId"]);
    if (input.identity.scopeKind !== "account" && input.identity.scopeKind !== "space") throw new Error("INVALID_INPUT");
    return this.transaction(() => {
      const space = this.writeSpace(input.space);
      const { scopeKind, ...identityInput } = input.identity;
      const identity = this.writeIdentity({ ...identityInput, providerId: space.providerId, accountId: space.accountId, scope: scopeKind === "space" ? { kind: "space", spaceId: space.id } : { kind: "account" } });
      const membership = this.writeMembership({ ...input.membership, spaceId: space.id, identityId: identity.id });
      return { space, identity, membership };
    });
  }
  private writeMembership(input: MembershipObservation): Membership {
    record(input,["spaceId","identityId","displayName","role","observedAt","source","sourceEventId"]);
    const spaceId = id(input.spaceId), identityId = id(input.identityId), name = text(input.displayName,512,true), role = text(input.role,128,true), o = observe(input), now = new Date().toISOString();
    const space = this.getSpace(spaceId), identity = this.getIdentity(identityId);
    if (!space || !identity) throw new Error("NOT_FOUND");
    if (space.providerId !== identity.providerId || space.accountId !== identity.accountId || (identity.scopeKind === "space" && identity.scopeSpaceId !== spaceId)) throw new Error("SCOPE_MISMATCH");
    this.db.prepare(`INSERT INTO memberships(id,space_id,identity_id,provider_id,account_id,display_name,display_name_observed_at,display_name_source,role,role_observed_at,role_source,first_seen_at,last_seen_at,observed_at,observation_source,source_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(space_id,identity_id) DO UPDATE SET
      first_seen_at=min(first_seen_at,excluded.first_seen_at), last_seen_at=max(last_seen_at,excluded.last_seen_at), observed_at=max(observed_at,excluded.observed_at),
      observation_source=CASE WHEN excluded.observed_at>observed_at THEN excluded.observation_source ELSE observation_source END,
      source_event_id=CASE WHEN excluded.observed_at>observed_at THEN excluded.source_event_id ELSE source_event_id END,
      display_name=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name ELSE display_name END,
      display_name_source=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name_source ELSE display_name_source END,
      display_name_observed_at=CASE WHEN excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at) THEN excluded.display_name_observed_at ELSE display_name_observed_at END,
      role=CASE WHEN excluded.role IS NOT NULL AND (role_observed_at IS NULL OR excluded.role_observed_at>role_observed_at) THEN excluded.role ELSE role END,
      role_source=CASE WHEN excluded.role IS NOT NULL AND (role_observed_at IS NULL OR excluded.role_observed_at>role_observed_at) THEN excluded.role_source ELSE role_source END,
      role_observed_at=CASE WHEN excluded.role IS NOT NULL AND (role_observed_at IS NULL OR excluded.role_observed_at>role_observed_at) THEN excluded.role_observed_at ELSE role_observed_at END,
      updated_at=CASE WHEN excluded.first_seen_at<first_seen_at OR excluded.last_seen_at>last_seen_at OR (excluded.display_name IS NOT NULL AND (display_name_observed_at IS NULL OR excluded.display_name_observed_at>display_name_observed_at)) OR (excluded.role IS NOT NULL AND (role_observed_at IS NULL OR excluded.role_observed_at>role_observed_at)) THEN excluded.updated_at ELSE updated_at END`).run(
        randomUUID(),spaceId,identityId,space.providerId,space.accountId,name,name ? o.at : null,name ? o.source : null,role,role ? o.at : null,role ? o.source : null,o.at,o.at,o.at,o.source,o.event,now,now);
    return this.db.prepare(`SELECT ${memberCols} FROM memberships WHERE space_id=? AND identity_id=?`).get(spaceId,identityId) as unknown as Membership;
  }
  listSpaceMembers(spaceId: string): Membership[] { if (!this.getSpace(spaceId)) throw new Error("NOT_FOUND"); return this.db.prepare(`SELECT ${memberCols} FROM memberships WHERE space_id=? ORDER BY last_seen_at DESC,id`).all(spaceId) as unknown as Membership[]; }
  listIdentitySpaces(identityId: string): Membership[] { return this.db.prepare(`SELECT ${memberCols} FROM memberships WHERE identity_id=? ORDER BY last_seen_at DESC,id`).all(id(identityId)) as unknown as Membership[]; }
  listPersonSpaces(personId: string): Membership[] {
    if (!this.getPerson(personId)) throw new Error("NOT_FOUND");
    const qualified = memberCols.split(", ").map(column => `m.${column}`).join(", ");
    return this.db.prepare(`SELECT ${qualified} FROM memberships m JOIN identities i ON i.id=m.identity_id WHERE i.person_id=? ORDER BY m.last_seen_at DESC,m.id`).all(personId) as unknown as Membership[];
  }
  removeMembership(membershipId: string): void { this.transaction(() => { if (!this.db.prepare("DELETE FROM memberships WHERE id=?").run(id(membershipId)).changes) throw new Error("NOT_FOUND"); }); }

  /** Read-only management projections deliberately exclude platform identifiers and raw events. */
  managementPeople(search: string, limit: number, offset: number, state: "active" | "merged" = "active") {
    return this.db.prepare(`SELECT p.id,p.merged_into_id AS mergedIntoId,coalesce(p.manual_name,(SELECT i.display_name FROM identities i WHERE i.person_id=p.id AND i.display_name IS NOT NULL ORDER BY i.display_name_observed_at DESC,i.id LIMIT 1),CASE WHEN p.display_name_source!='manual' THEN p.display_name END) AS displayName,p.status,p.created_at AS createdAt,p.updated_at AS updatedAt,
      (SELECT count(*) FROM identities i WHERE i.person_id=p.id) AS identityCount,
      (SELECT count(DISTINCT m.space_id) FROM identities i JOIN memberships m ON m.identity_id=i.id WHERE i.person_id=p.id) AS spaceCount,
      (SELECT min(observed) FROM (SELECT i.first_seen_at AS observed FROM identities i WHERE i.person_id=p.id UNION ALL SELECT m.first_seen_at FROM identities i JOIN memberships m ON m.identity_id=i.id WHERE i.person_id=p.id)) AS firstSeenAt,
      (SELECT max(observed) FROM (SELECT i.last_seen_at AS observed FROM identities i WHERE i.person_id=p.id UNION ALL SELECT m.last_seen_at FROM identities i JOIN memberships m ON m.identity_id=i.id WHERE i.person_id=p.id)) AS lastSeenAt,
      (SELECT group_concat(provider_id) FROM (SELECT DISTINCT i.provider_id FROM identities i WHERE i.person_id=p.id ORDER BY i.provider_id LIMIT 10)) AS providers
      FROM people p WHERE (CASE WHEN ?='merged' THEN p.merged_into_id IS NOT NULL ELSE p.merged_into_id IS NULL END) AND (?='' OR instr(lower(p.id),lower(?))>0 OR instr(lower(coalesce(p.manual_name,p.display_name,'')),lower(?))>0
        OR EXISTS(SELECT 1 FROM identities i WHERE i.person_id=p.id AND instr(lower(coalesce(i.display_name,'')),lower(?))>0))
      ORDER BY lastSeenAt DESC,p.id ASC LIMIT ? OFFSET ?`).all(state,search,search,search,search,limit,offset);
  }
  managementPerson(personId: string) {
    const person = this.getPerson(personId);
    if (!person) throw new Error("NOT_FOUND");
    const latest = this.db.prepare("SELECT display_name AS name FROM identities WHERE person_id=? AND display_name IS NOT NULL ORDER BY display_name_observed_at DESC,id LIMIT 1").get(personId)?.name;
    const observedName = typeof latest === "string" ? latest : person.displayNameSource === "manual" ? null : person.displayName;
    return { ...person, observedName, displayName: person.manualName ?? observedName };
  }
  managementPersonIdentities(personId: string, limit: number, offset: number) {
    if (!this.getPerson(personId)) throw new Error("NOT_FOUND");
    return this.db.prepare(`SELECT id,provider_id AS providerId,identity_type AS identityType,scope_kind AS scopeKind,scope_space_id AS scopeSpaceId,
      display_name AS displayName,display_name_source AS displayNameSource,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,observation_source AS observationSource,link_method AS linkMethod,link_version AS linkVersion,
      (SELECT count(*) FROM memberships m WHERE m.identity_id=identities.id) AS spaceCount
      FROM identities WHERE person_id=? ORDER BY last_seen_at DESC,id ASC LIMIT ? OFFSET ?`).all(personId,limit,offset);
  }
  managementPersonSpaces(personId: string, limit: number, offset: number) {
    if (!this.getPerson(personId)) throw new Error("NOT_FOUND");
    return this.db.prepare(`SELECT m.id,m.space_id AS spaceId,s.display_name AS spaceName,s.provider_id AS providerId,s.space_type AS spaceType,
      m.display_name AS displayName,m.role,m.first_seen_at AS firstSeenAt,m.last_seen_at AS lastSeenAt,i.identity_type AS identityType
      FROM identities i JOIN memberships m ON m.identity_id=i.id JOIN spaces s ON s.id=m.space_id WHERE i.person_id=?
      ORDER BY m.last_seen_at DESC,m.id ASC LIMIT ? OFFSET ?`).all(personId,limit,offset);
  }
  managementSpaces(search: string, limit: number, offset: number) {
    return this.db.prepare(`SELECT s.id,s.provider_id AS providerId,s.space_type AS spaceType,s.display_name AS displayName,s.first_seen_at AS firstSeenAt,s.last_seen_at AS lastSeenAt,
      (SELECT count(*) FROM memberships m WHERE m.space_id=s.id) AS memberCount FROM spaces s
      WHERE ?='' OR instr(lower(s.id),lower(?))>0 OR instr(lower(coalesce(s.display_name,'')),lower(?))>0 OR instr(lower(s.provider_id),lower(?))>0
      ORDER BY s.last_seen_at DESC,s.id ASC LIMIT ? OFFSET ?`).all(search,search,search,search,limit,offset);
  }
  managementSpace(spaceId: string) {
    const space = this.getSpace(spaceId);
    if (!space) throw new Error("NOT_FOUND");
    const memberCount = this.db.prepare("SELECT count(*) AS count FROM memberships WHERE space_id=?").get(spaceId)?.count;
    return { id: space.id, providerId: space.providerId, spaceType: space.spaceType, displayName: space.displayName, displayNameSource: space.displayNameSource, firstSeenAt: space.firstSeenAt, lastSeenAt: space.lastSeenAt, observationSource: space.observationSource, memberCount };
  }
  managementSpaceMembers(spaceId: string, limit: number, offset: number) {
    if (!this.getSpace(spaceId)) throw new Error("NOT_FOUND");
    return this.db.prepare(`SELECT m.id,m.display_name AS displayName,m.role,m.first_seen_at AS firstSeenAt,m.last_seen_at AS lastSeenAt,
      i.identity_type AS identityType,p.id AS personId,coalesce(p.manual_name,(SELECT i2.display_name FROM identities i2 WHERE i2.person_id=p.id AND i2.display_name IS NOT NULL ORDER BY i2.display_name_observed_at DESC,i2.id LIMIT 1),CASE WHEN p.display_name_source!='manual' THEN p.display_name END) AS personName
      FROM memberships m JOIN identities i ON i.id=m.identity_id JOIN people p ON p.id=i.person_id
      WHERE m.space_id=? ORDER BY m.last_seen_at DESC,m.id ASC LIMIT ? OFFSET ?`).all(spaceId,limit,offset);
  }

  private audit(operation: string, targetType: string, targetId: string, sourcePersonId: string | null, targetPersonId: string | null, before: unknown, after: unknown, reason: string | null, undoOf: string | null = null, auditId = randomUUID()): string {
    this.db.prepare(`INSERT INTO people_audit(id,operation,actor,target_type,target_id,source_person_id,target_person_id,before_json,after_json,reason,created_at,result,undo_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(auditId,operation,"local-administrator",targetType,targetId,sourcePersonId,targetPersonId,JSON.stringify(before),JSON.stringify(after),reason,new Date().toISOString(),"success",undoOf);
    return auditId;
  }
  private assertNoPlatformIdentifiers(value: string | null): void {
    if (!value) return;
    // Do not persist known platform identifiers even if they are pasted into a reason.
    const hit = this.db.prepare(`SELECT 1 FROM identities WHERE (length(external_id)>0 AND instr(?,external_id)>0) OR (length(account_id)>0 AND instr(?,account_id)>0) UNION ALL SELECT 1 FROM spaces WHERE length(external_id)>0 AND instr(?,external_id)>0 LIMIT 1`).get(value,value,value);
    if (hit) throw new Error("INVALID_INPUT");
  }
  private redactKnownIdentifiers(value: string | null): string | null {
    if (!value) return value;
    const found = this.db.prepare(`SELECT external_id AS value FROM identities WHERE length(external_id)>0 AND instr(?,external_id)>0
      UNION SELECT account_id FROM identities WHERE length(account_id)>0 AND instr(?,account_id)>0
      UNION SELECT external_id FROM spaces WHERE length(external_id)>0 AND instr(?,external_id)>0`).all(value,value,value);
    let result = value;
    for (const item of found) if (typeof item.value === "string") result = result.split(item.value).join("[平台标识已隐去]");
    return result;
  }
  private safeReason(value: unknown): string {
    const reason = noteText(value, 1000, true)!;
    this.assertNoPlatformIdentifiers(reason);
    return reason;
  }
  editPerson(personId: string, expectedVersion: number, manualName: unknown, note: unknown) {
    id(personId); revision(expectedVersion);
    const name = manualName === null || manualName === "" ? null : text(manualName,512), normalizedNote = noteText(note,4000);
    return this.transaction(() => {
      this.assertNoPlatformIdentifiers(name); this.assertNoPlatformIdentifiers(normalizedNote);
      const before = this.activePerson(personId);
      if (before.version !== expectedVersion) throw new Error("CONFLICT");
      if (before.manualName === name && before.note === normalizedNote) return this.managementPerson(personId);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE people SET manual_name=?,note=?,version=version+1,updated_at=? WHERE id=?").run(name,normalizedNote,now,personId);
      if (before.manualName !== name) this.audit(name === null ? "name_clear" : "name_set", "person",personId,personId,personId,{ manualName: this.redactKnownIdentifiers(before.manualName) },{ manualName: name },null);
      if (before.note !== normalizedNote) this.audit("note_set","person",personId,personId,personId,{ note: this.redactKnownIdentifiers(before.note) },{ note: normalizedNote },null);
      return this.managementPerson(personId);
    });
  }
  managementIdentity(identityId: string) {
    id(identityId);
    const row = this.db.prepare(`SELECT i.id,i.person_id AS personId,i.provider_id AS providerId,i.identity_type AS identityType,i.display_name AS displayName,i.scope_kind AS scopeKind,
      i.link_method AS linkMethod,i.link_version AS linkVersion,coalesce(p.manual_name,(SELECT i2.display_name FROM identities i2 WHERE i2.person_id=p.id AND i2.display_name IS NOT NULL ORDER BY i2.display_name_observed_at DESC,i2.id LIMIT 1),CASE WHEN p.display_name_source!='manual' THEN p.display_name END) AS personName,
      (SELECT count(*) FROM memberships m WHERE m.identity_id=i.id) AS spaceCount,
      (SELECT count(*) FROM identities other WHERE other.person_id=i.person_id) AS personIdentityCount
      FROM identities i JOIN people p ON p.id=i.person_id WHERE i.id=?`).get(identityId);
    if (!row) throw new Error("NOT_FOUND"); return row;
  }
  private identityLink(identityId: string): { personId: string; linkVersion: number; linkMethod: string; displayName: string | null; source: string; at: string; nameAt: string | null; nameSource: string | null } {
    const row = this.db.prepare(`SELECT person_id AS personId,link_version AS linkVersion,link_method AS linkMethod,display_name AS displayName,observation_source AS source,last_seen_at AS at,display_name_observed_at AS nameAt,display_name_source AS nameSource FROM identities WHERE id=?`).get(id(identityId));
    if (!row) throw new Error("NOT_FOUND"); return row as unknown as ReturnType<PeopleRepository["identityLink"]>;
  }
  reassignIdentity(identityId: string, personId: string, expectedVersion: number, reason: unknown) {
    id(identityId); id(personId); revision(expectedVersion);
    return this.transaction(() => {
      const why = this.safeReason(reason), before = this.identityLink(identityId);
      this.activePerson(before.personId); this.activePerson(personId);
      if (before.linkVersion !== expectedVersion || before.personId === personId) throw new Error("CONFLICT");
      this.db.prepare("UPDATE identities SET person_id=?,link_method='manual_confirmation',link_version=link_version+1,updated_at=? WHERE id=?").run(personId,new Date().toISOString(),identityId);
      const after = this.identityLink(identityId);
      const auditId = this.audit("identity_reassign","identity",identityId,before.personId,personId,{ personId: before.personId, linkVersion: before.linkVersion, linkMethod: before.linkMethod },{ personId, linkVersion: after.linkVersion, linkMethod: after.linkMethod },why);
      return { identity: this.managementIdentity(identityId), auditId };
    });
  }
  detachIdentity(identityId: string, expectedVersion: number, reason: unknown) {
    id(identityId); revision(expectedVersion);
    return this.transaction(() => {
      const why = this.safeReason(reason), before = this.identityLink(identityId);
      this.activePerson(before.personId);
      if (before.linkVersion !== expectedVersion || before.linkMethod !== "manual_confirmation") throw new Error("CONFLICT");
      const person = this.insertPerson(before.displayName,"provisional",{ at: before.nameAt ?? before.at, source: before.nameSource ?? before.source });
      this.db.prepare("UPDATE identities SET person_id=?,link_method='observed',link_version=link_version+1,updated_at=? WHERE id=?").run(person.id,new Date().toISOString(),identityId);
      const after = this.identityLink(identityId);
      const auditId = this.audit("identity_detach","identity",identityId,before.personId,person.id,{ personId: before.personId, linkVersion: before.linkVersion, linkMethod: before.linkMethod },{ personId: person.id, linkVersion: after.linkVersion, linkMethod: after.linkMethod },why);
      return { identity: this.managementIdentity(identityId), personId: person.id, auditId };
    });
  }
  undoIdentity(auditId: string, reason: unknown) {
    id(auditId);
    return this.transaction(() => {
      const why = this.safeReason(reason);
      const row = this.db.prepare("SELECT id,operation,target_id AS targetId,before_json AS beforeJson,after_json AS afterJson FROM people_audit WHERE id=?").get(auditId) as { id: string; operation: string; targetId: string; beforeJson: string; afterJson: string } | undefined;
      if (!row) throw new Error("NOT_FOUND");
      if (!["identity_reassign","identity_detach"].includes(row.operation) || this.db.prepare("SELECT 1 FROM people_audit WHERE undo_of=?").get(auditId)) throw new Error("CONFLICT");
      const before = JSON.parse(row.beforeJson) as { personId: string; linkVersion: number; linkMethod: string }, after = JSON.parse(row.afterJson) as typeof before;
      const current = this.identityLink(row.targetId);
      if (current.personId !== after.personId || current.linkVersion !== after.linkVersion || current.linkMethod !== after.linkMethod || !this.getPerson(before.personId) || this.getPerson(before.personId)?.mergedIntoId || this.getPerson(current.personId)?.mergedIntoId) throw new Error("CONFLICT");
      this.db.prepare("UPDATE identities SET person_id=?,link_method=?,link_version=link_version+1,updated_at=? WHERE id=?").run(before.personId,before.linkMethod,new Date().toISOString(),row.targetId);
      const updated = this.identityLink(row.targetId);
      const undoId = this.audit("identity_undo","identity",row.targetId,current.personId,before.personId,{ personId: current.personId, linkVersion: current.linkVersion, linkMethod: current.linkMethod },{ personId: updated.personId, linkVersion: updated.linkVersion, linkMethod: updated.linkMethod },why,auditId);
      return { identity: this.managementIdentity(row.targetId), auditId: undoId };
    });
  }

  private batchIdentities(personId: string) {
    const rows = this.db.prepare(`SELECT id,person_id AS personId,link_version AS linkVersion,link_method AS linkMethod,provider_id AS providerId,identity_type AS identityType,display_name AS displayName,scope_kind AS scopeKind,
      (SELECT count(*) FROM memberships m WHERE m.identity_id=identities.id) AS membershipCount FROM identities WHERE person_id=? ORDER BY id LIMIT 101`).all(personId) as unknown as Array<{ id:string; personId:string; linkVersion:number; linkMethod:string; providerId:string; identityType:string; displayName:string|null; scopeKind:string; membershipCount:number }>;
    if (rows.length > 100) throw new Error("BATCH_LIMIT"); return rows;
  }
  private batchOptions(value: unknown) {
    record(value,["nameChoice","noteChoice","manualName","note"]);
    if (typeof value.nameChoice !== "string" || typeof value.noteChoice !== "string" || !["target","source","custom"].includes(value.nameChoice) || !["target","source","custom"].includes(value.noteChoice)) throw new Error("INVALID_INPUT");
    if ((value.nameChoice !== "custom" && value.manualName !== undefined) || (value.noteChoice !== "custom" && value.note !== undefined)) throw new Error("INVALID_INPUT");
    const name = value.nameChoice === "custom" ? (value.manualName === null || value.manualName === "" ? null : text(value.manualName,512)) : undefined;
    const note = value.noteChoice === "custom" ? noteText(value.note,4000) : undefined;
    return { nameChoice: value.nameChoice as "target"|"source"|"custom", noteChoice: value.noteChoice as "target"|"source"|"custom", ...(name === undefined ? {} : { manualName: name }), ...(note === undefined ? {} : { note }) };
  }
  private fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private mergePreviewData(sourceId: string, targetId: string, options: unknown) {
    id(sourceId); id(targetId); if (sourceId === targetId) throw new Error("CONFLICT");
    const source = this.activePerson(sourceId), target = this.activePerson(targetId), choices = this.batchOptions(options);
    if (this.db.prepare("SELECT 1 FROM people WHERE merged_into_id=? LIMIT 1").get(sourceId)) throw new Error("CONFLICT");
    const identities = this.batchIdentities(sourceId), targetIdentities = this.batchIdentities(targetId);
    if (identities.length + targetIdentities.length > 100) throw new Error("BATCH_LIMIT");
    const spaces = this.db.prepare(`SELECT count(DISTINCT m.space_id) AS count FROM memberships m JOIN identities i ON i.id=m.identity_id WHERE i.person_id=?`).get(sourceId)?.count;
    const manualName = choices.nameChoice === "source" ? source.manualName : choices.nameChoice === "custom" ? choices.manualName ?? null : target.manualName;
    const note = choices.noteChoice === "source" ? source.note : choices.noteChoice === "custom" ? choices.note ?? null : target.note;
    this.assertNoPlatformIdentifiers(target.manualName); this.assertNoPlatformIdentifiers(target.note); this.assertNoPlatformIdentifiers(manualName); this.assertNoPlatformIdentifiers(note);
    return { source: this.managementPerson(sourceId), target: this.managementPerson(targetId), identities, targetIdentities, spaceCount: Number(spaces), membershipCount: identities.reduce((n,row)=>n+row.membershipCount,0), choices, final: { manualName, note } };
  }
  previewMerge(sourceId: string, targetId: string, options: unknown) {
    const preview = this.mergePreviewData(sourceId,targetId,options); return { ...preview, fingerprint: this.fingerprint(preview) };
  }
  mergePeople(sourceId: string, targetId: string, options: unknown, fingerprint: unknown, reason: unknown) {
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("INVALID_INPUT");
    return this.transaction(() => {
      const why = this.safeReason(reason), preview = this.mergePreviewData(sourceId,targetId,options);
      if (this.fingerprint(preview) !== fingerprint) throw new Error("CONFLICT");
      const auditId = randomUUID(), now = new Date().toISOString();
      for (const item of preview.identities) this.db.prepare("UPDATE identities SET person_id=?,link_method='manual_confirmation',link_version=link_version+1,updated_at=? WHERE id=?").run(targetId,now,item.id);
      this.db.prepare("UPDATE people SET manual_name=?,note=?,version=version+1,updated_at=? WHERE id=?").run(preview.final.manualName,preview.final.note,now,targetId);
      this.db.prepare("UPDATE people SET merged_into_id=?,merged_at=?,merge_audit_id=?,version=version+1,updated_at=? WHERE id=?").run(targetId,now,auditId,now,sourceId);
      const after = { sourceVersion: preview.source.version+1, targetVersion: preview.target.version+1, identities: this.batchIdentities(targetId).map(item => ({ id:item.id,linkVersion:item.linkVersion,linkMethod:item.linkMethod })), final: preview.final };
      const before = { sourceId,targetId,targetProfile: { manualName:preview.target.manualName,note:preview.target.note }, identities:preview.identities.map(item => ({ id:item.id,linkVersion:item.linkVersion,linkMethod:item.linkMethod })), choices:preview.choices };
      this.audit("person_merge","person",sourceId,sourceId,targetId,before,after,why,null,auditId);
      return { auditId, sourceId, targetId };
    });
  }
  private splitPreviewData(sourceId: string, targetId: string | null, selected: unknown) {
    id(sourceId); if (targetId !== null) { id(targetId); if (sourceId === targetId) throw new Error("CONFLICT"); }
    if (!Array.isArray(selected) || !selected.length || selected.length > 100 || selected.some(value => typeof value !== "string" || !uuid.test(value)) || new Set(selected).size !== selected.length) throw new Error("INVALID_INPUT");
    this.activePerson(sourceId); if (targetId) this.activePerson(targetId);
    const all = this.batchIdentities(sourceId), targetIdentities = targetId ? this.batchIdentities(targetId) : [], wanted = new Set(selected);
    const identities = all.filter(item => wanted.has(item.id)); if (identities.length !== selected.length) throw new Error("CONFLICT");
    if (targetIdentities.length + identities.length > 100) throw new Error("BATCH_LIMIT");
    const placeholders = identities.map(() => "?").join(",");
    const spaces = this.db.prepare(`SELECT count(DISTINCT space_id) AS count FROM memberships WHERE identity_id IN (${placeholders})`).get(...identities.map(item=>item.id))?.count;
    return { source:this.managementPerson(sourceId), target:targetId ? this.managementPerson(targetId) : null, identities, sourceIdentities:all, targetIdentities, spaceCount:Number(spaces), membershipCount:identities.reduce((n,row)=>n+row.membershipCount,0) };
  }
  previewSplit(sourceId: string, targetId: string | null, identities: unknown) {
    const preview = this.splitPreviewData(sourceId,targetId,identities); return { ...preview, fingerprint:this.fingerprint(preview) };
  }
  splitPeople(sourceId: string, targetId: string | null, identities: unknown, fingerprint: unknown, reason: unknown) {
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("INVALID_INPUT");
    return this.transaction(() => {
      const why = this.safeReason(reason), preview = this.splitPreviewData(sourceId,targetId,identities);
      if (this.fingerprint(preview) !== fingerprint) throw new Error("CONFLICT");
      const destination = targetId ?? this.insertPerson(null,"provisional").id, now = new Date().toISOString();
      for (const item of preview.identities) this.db.prepare("UPDATE identities SET person_id=?,link_method='manual_confirmation',link_version=link_version+1,updated_at=? WHERE id=?").run(destination,now,item.id);
      this.db.prepare("UPDATE people SET version=version+1,updated_at=? WHERE id IN (?,?)").run(now,sourceId,destination);
      const before = { sourceId,targetId, identities:preview.identities.map(item=>({id:item.id,linkVersion:item.linkVersion,linkMethod:item.linkMethod})) };
      const after = { sourceId,targetId:destination, identities:preview.identities.map(item=>({id:item.id,linkVersion:item.linkVersion+1})) };
      const auditId = this.audit("person_split","person",sourceId,sourceId,destination,before,after,why);
      return { auditId,sourceId,targetId:destination };
    });
  }
  private mergeUndoState(auditId: string) {
    const row = this.db.prepare("SELECT id,operation,source_person_id AS sourceId,target_person_id AS targetId,before_json AS beforeJson,after_json AS afterJson FROM people_audit WHERE id=?").get(id(auditId)) as { id:string; operation:string; sourceId:string; targetId:string; beforeJson:string; afterJson:string } | undefined;
    if (!row) throw new Error("NOT_FOUND");
    if (row.operation !== "person_merge" || this.db.prepare("SELECT 1 FROM people_audit WHERE undo_of=?").get(auditId)) throw new Error("CONFLICT");
    const before = JSON.parse(row.beforeJson) as { sourceId:string; targetId:string; targetProfile:{manualName:string|null;note:string|null}; identities:Array<{id:string;linkVersion:number;linkMethod:string}> };
    const after = JSON.parse(row.afterJson) as { sourceVersion:number;targetVersion:number;identities:Array<{id:string;linkVersion:number;linkMethod:string}> };
    const source = this.getPerson(row.sourceId), target = this.getPerson(row.targetId);
    if (!source || !target || source.mergedIntoId !== row.targetId || source.mergeAuditId !== auditId || target.mergedIntoId || source.version !== after.sourceVersion || target.version !== after.targetVersion) throw new Error("CONFLICT");
    const targetLinks = this.batchIdentities(row.targetId).map(item => ({ id:item.id,linkVersion:item.linkVersion,linkMethod:item.linkMethod }));
    if (JSON.stringify(targetLinks) !== JSON.stringify(after.identities) || this.batchIdentities(row.sourceId).length) throw new Error("CONFLICT");
    return { row,before,after };
  }
  undoMerge(auditId: string, reason: unknown) {
    return this.transaction(() => {
      const why = this.safeReason(reason), state = this.mergeUndoState(auditId), { row,before,after } = state, now = new Date().toISOString();
      this.db.prepare("UPDATE people SET merged_into_id=NULL,merged_at=NULL,merge_audit_id=NULL,version=version+1,updated_at=? WHERE id=?").run(now,row.sourceId);
      for (const item of before.identities) this.db.prepare("UPDATE identities SET person_id=?,link_method=?,link_version=link_version+1,updated_at=? WHERE id=?").run(row.sourceId,item.linkMethod,now,item.id);
      this.db.prepare("UPDATE people SET manual_name=?,note=?,version=version+1,updated_at=? WHERE id=?").run(before.targetProfile.manualName,before.targetProfile.note,now,row.targetId);
      const undoId = this.audit("person_merge_undo","person",row.sourceId,row.targetId,row.sourceId,{ originalAuditId:auditId,targetVersion:after.targetVersion },{ sourceId:row.sourceId,targetId:row.targetId,identities:before.identities.map(item=>item.id) },why,auditId);
      return { auditId:undoId,sourceId:row.sourceId,targetId:row.targetId };
    });
  }
  managementAudit(personId: string, limit: number, offset: number) {
    if (!this.getPerson(personId)) throw new Error("NOT_FOUND");
    const rows = this.db.prepare(`SELECT a.id,a.operation,a.actor,a.target_type AS targetType,a.target_id AS targetId,a.source_person_id AS sourcePersonId,a.target_person_id AS targetPersonId,
      a.before_json AS beforeJson,a.after_json AS afterJson,a.reason,a.created_at AS createdAt,a.result,a.undo_of AS undoOf,
      EXISTS(SELECT 1 FROM people_audit u WHERE u.undo_of=a.id) AS undone
      FROM people_audit a WHERE a.source_person_id=? OR a.target_person_id=? ORDER BY a.sequence DESC LIMIT ? OFFSET ?`).all(personId,personId,limit,offset) as unknown as Array<Record<string, string | number | null>>;
    return rows.map(row => {
      const before = JSON.parse(String(row.beforeJson)) as Record<string, unknown>, after = JSON.parse(String(row.afterJson)) as Record<string, unknown>;
      let canUndo = false;
      if (["identity_reassign","identity_detach"].includes(String(row.operation)) && !row.undone) {
        const current = this.db.prepare("SELECT person_id AS personId,link_version AS linkVersion,link_method AS linkMethod FROM identities WHERE id=?").get(String(row.targetId));
        const oldPerson = this.getPerson(String(before.personId));
        canUndo = !!current && current.personId === after.personId && current.linkVersion === after.linkVersion && current.linkMethod === after.linkMethod && !!oldPerson && !oldPerson.mergedIntoId && !this.getPerson(String(after.personId))?.mergedIntoId;
      }
      if (row.operation === "person_merge" && !row.undone) { try { this.mergeUndoState(String(row.id)); canUndo = true; } catch { /* Subsequent changes make restoration unsafe. */ } }
      const { beforeJson: _before, afterJson: _after, ...safe } = row;
      return { ...safe, before, after, canUndo };
    });
  }
}
