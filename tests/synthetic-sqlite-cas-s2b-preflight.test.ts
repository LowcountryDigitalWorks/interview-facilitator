import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeJson } from '../src/pack-identity';
import { createSemanticSession } from '../src/semantic-session';
import { generalDiscoveryPack } from '../src/pack';
import {
  prepareSyntheticRevisionOffer,
  SYNTHETIC_SYNC_PLAN_VERSION,
  type SyntheticSyncOffer,
} from '../src/synthetic-sync-plan';

/**
 * S2B-0: test-only, real file-backed SQLite transactions using Node 24's
 * built-in driver. NOT D1, a provider test, authentication or client sync.
 * No runtime imports, external network, customer data or extra dependency.
 */
const schema = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic-sqlite-cas-schema-s2b.sql', import.meta.url)),
  'utf8',
);

type Scope = {
  tenantId: string;
  clientId: string;
  engagementId: string;
  sessionId: string;
};
type Outcome = 'committed' | 'replayed' | 'conflict' | 'deny' | 'rolled-back' | 'reply-lost' | 'busy';
type Fault = 'none' | 'sql-constraint' | 'lost-reply';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const scopeValues = (scope: Scope) => [
  scope.tenantId, scope.clientId, scope.engagementId, scope.sessionId,
] as const;

function createFixtureDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'ldw-if-sqlite-synthetic-'));
  const file = join(directory, 'fictional-only.db');
  const open = () => {
    const db = new DatabaseSync(file, { timeout: 0 });
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    return db;
  };
  const db = open();
  db.exec(schema);
  return {
    db, open,
    close: (...handles: DatabaseSync[]) => {
      for (const handle of handles) handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** A privileged SYNTHETIC fixture mutation, not a customer-grant endpoint. */
function seedGrant(db: DatabaseSync, scope: Scope, actor: string, active = 1, assigned = 1, canAppend = 1) {
  db.prepare(`
    INSERT INTO grants
      (tenant_id, client_id, engagement_id, session_id, actor_id, active, assigned, append_allowed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tenant_id, client_id, engagement_id, session_id, actor_id)
    DO UPDATE SET active=excluded.active,
      assigned=excluded.assigned, append_allowed=excluded.append_allowed
  `).run(...scopeValues(scope), actor, active, assigned, canAppend);
}

function count(db: DatabaseSync, table: 'current_heads'|'immutable_revisions'|'durable_receipts_trial', scope: Scope) {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}
    WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=?`)
    .get(...scopeValues(scope)) as { n: number };
  return row.n;
}

function current(db: DatabaseSync, scope: Scope): string | null {
  const row = db.prepare(`SELECT revision_id FROM current_heads
    WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=?`)
    .get(...scopeValues(scope)) as { revision_id: string } | undefined;
  return row?.revision_id ?? null;
}

/**
 * This deliberately simple TEST-only server procedure uses real BEGIN
 * IMMEDIATE/COMMIT/ROLLBACK and SQL WHERE-CAS. The caller-supplied actor
 * string is NOT authenticated; all records are fictional metadata only.
 */
function appendForSqliteTrial(
  db: DatabaseSync,
  scope: Scope,
  actor: string,
  offer: SyntheticSyncOffer,
  expectedRevision: string | null,
  fault: Fault = 'none',
  onBeforeCommit?: () => void,
): Outcome {
  const head = offer?.head;
  const ids = [...scopeValues(scope), actor];
  if (ids.some(x => typeof x !== 'string' || !ID.test(x))
    || !head || head.protocolVersion !== SYNTHETIC_SYNC_PLAN_VERSION
    || head.sessionSchemaVersion !== '1.3.0' || head.sessionId !== scope.sessionId
    || !ID.test(head.revisionId) || !DIGEST.test(head.snapshotDigest)
    || !DIGEST.test(head.packDigest)
    || !(head.parentRevisionId === null || (ID.test(head.parentRevisionId) && head.parentRevisionId !== head.revisionId))
    || !(expectedRevision === null || (typeof expectedRevision === 'string' && ID.test(expectedRevision)))
    || !DIGEST.test(offer.operationId)) return 'deny';
  const computedOp = createHash('sha256').update(canonicalizeJson({
    protocol: SYNTHETIC_SYNC_PLAN_VERSION,
    sessionId: head.sessionId,
    revisionId: head.revisionId,
    snapshotDigest: head.snapshotDigest,
  })).digest('hex');
  if (offer.operationId !== computedOp) return 'deny';

  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if (String(error).includes('SQLITE_BUSY') || String(error).includes('database is locked')) return 'busy';
    throw error;
  }
  let active = true;
  try {
    const grant = db.prepare(`SELECT active, assigned, append_allowed FROM grants
      WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=? AND actor_id=?`)
      .get(...ids) as { active: number; assigned: number; append_allowed: number } | undefined;
    if (!grant || grant.active !== 1 || grant.assigned !== 1 || grant.append_allowed !== 1) {
      db.exec('ROLLBACK');
      active = false;
      return 'deny';
    }

    const receipt = db.prepare(`SELECT revision_id, snapshot_digest FROM durable_receipts_trial
      WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=? AND operation_id=?`)
      .get(...scopeValues(scope), offer.operationId) as {
        revision_id: string; snapshot_digest: string;
      } | undefined;
    if (receipt) {
      const validReplay = receipt.revision_id === head.revisionId
        && receipt.snapshot_digest === head.snapshotDigest;
      db.exec('ROLLBACK');
      active = false;
      return validReplay ? 'replayed' : 'deny';
    }

    const previousId = current(db, scope);
    const hasHistoricalRevision = db.prepare(`SELECT 1 AS present FROM immutable_revisions
      WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=? AND revision_id=?`)
      .get(...scopeValues(scope), head.revisionId);
    if (hasHistoricalRevision) {
      db.exec('ROLLBACK');
      active = false;
      return 'conflict';
    }

    if (previousId === null) {
      if (expectedRevision !== null || head.parentRevisionId !== null) {
        db.exec('ROLLBACK');
        active = false;
        return 'conflict';
      }
      const inserted = db.prepare(`INSERT OR IGNORE INTO current_heads
        (tenant_id,client_id,engagement_id,session_id,revision_id,snapshot_digest,pack_digest)
        VALUES (?,?,?,?,?,?,?)`).run(...scopeValues(scope), head.revisionId,
          head.snapshotDigest, head.packDigest);
      if (inserted.changes !== 1) throw new Error('SYNTHETIC INSERT CAS not unique.');
    } else {
      const updated = db.prepare(`UPDATE current_heads
        SET revision_id=?, snapshot_digest=?
        WHERE tenant_id=? AND client_id=? AND engagement_id=? AND session_id=?
          AND revision_id=? AND pack_digest=?`)
        .run(head.revisionId, head.snapshotDigest, ...scopeValues(scope), expectedRevision,
          head.packDigest);
      if (updated.changes !== 1 || head.parentRevisionId !== previousId || expectedRevision !== previousId) {
        db.exec('ROLLBACK');
        active = false;
        return 'conflict';
      }
    }

    db.prepare(`INSERT INTO immutable_revisions
      (tenant_id,client_id,engagement_id,session_id,revision_id,parent_revision_id,
       snapshot_digest,pack_digest,operation_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(...scopeValues(scope), head.revisionId,
      head.parentRevisionId, head.snapshotDigest, head.packDigest, offer.operationId);

    if (fault === 'sql-constraint') {
      // Actual SQLite NOT NULL violation after earlier writes have occurred;
      // a genuine SQL error must roll back head + immutable history.
      db.prepare(`INSERT INTO durable_receipts_trial
        (tenant_id,client_id,engagement_id,session_id,operation_id,revision_id,snapshot_digest,committed)
        VALUES (?,?,?,?,?,?,?,?)`).run(...scopeValues(scope), offer.operationId,
        null, head.snapshotDigest, 1);
    } else {
      db.prepare(`INSERT INTO durable_receipts_trial
        (tenant_id,client_id,engagement_id,session_id,operation_id,revision_id,snapshot_digest,committed)
        VALUES (?,?,?,?,?,?,?,?)`).run(...scopeValues(scope), offer.operationId,
        head.revisionId, head.snapshotDigest, 1);
    }

    // Only for a TEST that holds a write lock while another connection tries
    // BEGIN IMMEDIATE. Real D1 behavior is NOT certified by this callback.
    onBeforeCommit?.();
    db.exec('COMMIT');
    active = false;
    return fault === 'lost-reply' ? 'reply-lost' : 'committed';
  } catch (error) {
    if (active) db.exec('ROLLBACK');
    if (fault === 'sql-constraint' && String(error).includes('NOT NULL')) return 'rolled-back';
    throw error;
  }
}

async function sample() {
  const session = await createSemanticSession(generalDiscoveryPack, {
    clientLabel: 'SYNTHETIC PRIVATE CLIENT NEVER SENT TO SQLITE',
  }, new Date('2026-11-14T12:00:00.000Z'));
  session.runningNotes = 'SYNTHETIC CONFIDENTIAL NOTES NOT IN SQL';
  const base = await prepareSyntheticRevisionOffer(session);
  const scope: Scope = {
    tenantId: 'synthetic-tenant', clientId: 'synthetic-client',
    engagementId: 'synthetic-engagement', sessionId: session.sessionId,
  };
  const makeChild = (revisionId: string, note: string) => prepareSyntheticRevisionOffer({
    ...session,
    revisionId, parentRevisionId: session.revisionId, runningNotes: note,
  });
  return { session, base, scope, makeChild };
}

describe('S2B-0 real SQLite / two-handle SYNTHETIC transaction preflight', () => {
  it('commits root, retained head and receipt together; close and reopen keeps replay idempotent', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      expect([count(env.db, 'current_heads', f.scope),
        count(env.db, 'immutable_revisions', f.scope),
        count(env.db, 'durable_receipts_trial', f.scope)]).toEqual([1, 1, 1]);
      env.db.close();
      const reopened = env.open();
      try {
        expect(appendForSqliteTrial(reopened, f.scope, actor, f.base, null)).toBe('replayed');
        expect(current(reopened, f.scope)).toBe(f.base.head.revisionId);
        expect(count(reopened, 'immutable_revisions', f.scope)).toBe(1);
        expect(count(reopened, 'durable_receipts_trial', f.scope)).toBe(1);
        const rows = reopened.prepare('SELECT * FROM immutable_revisions').all();
        const text = JSON.stringify(rows);
        expect(text).not.toContain(f.session.clientLabel);
        expect(text).not.toContain(f.session.runningNotes);
        expect(text).not.toContain('answers');
      } finally { reopened.close(); }
    } finally { env.close(); }
  });

  it('a genuine SQL constraint error rolls back head, history, and receipt before retry', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null, 'sql-constraint')).toBe('rolled-back');
      expect([count(env.db, 'current_heads', f.scope),
        count(env.db, 'immutable_revisions', f.scope),
        count(env.db, 'durable_receipts_trial', f.scope)]).toEqual([0, 0, 0]);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      expect(count(env.db, 'durable_receipts_trial', f.scope)).toBe(1);
    } finally { env.close(env.db); }
  });

  it('two distinct SQLite handles exhibit a real write lock; after winner commits, stale sibling conflicts', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    const second = env.open();
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      const left = await f.makeChild('synthetic-left', 'SYNTHETIC LEFT');
      const right = await f.makeChild('synthetic-right', 'SYNTHETIC RIGHT');
      let competing: Outcome | null = null;
      expect(appendForSqliteTrial(env.db, f.scope, actor, left, f.base.head.revisionId,
        'none', () => {
          competing = appendForSqliteTrial(second, f.scope, actor, right, f.base.head.revisionId);
        })).toBe('committed');
      expect(competing).toBe('busy');
      expect(appendForSqliteTrial(second, f.scope, actor, right, f.base.head.revisionId)).toBe('conflict');
      expect(current(second, f.scope)).toBe(left.head.revisionId);
      expect(count(second, 'immutable_revisions', f.scope)).toBe(2);
      expect(count(second, 'durable_receipts_trial', f.scope)).toBe(2);
    } finally { env.close(second, env.db); }
  });

  it('lost response after persisted SQL commit becomes scoped replay without duplicate state', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null, 'lost-reply')).toBe('reply-lost');
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('replayed');
      expect(count(env.db, 'immutable_revisions', f.scope)).toBe(1);
      expect(count(env.db, 'durable_receipts_trial', f.scope)).toBe(1);
    } finally { env.close(env.db); }
  });

  it('revoked actor or assignment denies even an earlier receipt replay', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      for (const flags of [[0,1,1],[1,0,1],[1,1,0]] as const) {
        seedGrant(env.db, f.scope, actor, ...flags);
        expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('deny');
        expect(count(env.db, 'durable_receipts_trial', f.scope)).toBe(1);
      }
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('replayed');
    } finally { env.close(env.db); }
  });

  it('four-part authorization scope denies cross-client and cross-engagement reads/writes', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      for (const key of ['tenantId','clientId','engagementId','sessionId'] as const) {
        const other = { ...f.scope, [key]: 'synthetic-other' };
        expect(appendForSqliteTrial(env.db, other, actor, f.base, null)).toBe('deny');
        expect(current(env.db, other)).toBeNull();
        expect(count(env.db, 'durable_receipts_trial', other)).toBe(0);
      }
      const secondEngagement = { ...f.scope, engagementId: 'synthetic-new-engagement' };
      seedGrant(env.db, secondEngagement, actor);
      expect(appendForSqliteTrial(env.db, secondEngagement, actor, f.base, null)).toBe('committed');
      expect(count(env.db, 'immutable_revisions', f.scope)).toBe(1);
      expect(count(env.db, 'immutable_revisions', secondEngagement)).toBe(1);
    } finally { env.close(env.db); }
  });

  it('historical revision identifiers remain immutable and divergent siblings cannot overwrite', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor, f.base, null)).toBe('committed');
      const left = await f.makeChild('synthetic-first-child', 'SYNTHETIC LEFT');
      const right = await f.makeChild('synthetic-second-child', 'SYNTHETIC RIGHT');
      expect(appendForSqliteTrial(env.db, f.scope, actor, left, f.base.head.revisionId)).toBe('committed');
      expect(appendForSqliteTrial(env.db, f.scope, actor, right, f.base.head.revisionId)).toBe('conflict');
      const next = await prepareSyntheticRevisionOffer({
        ...f.session, parentRevisionId: left.head.revisionId,
        revisionId: 'synthetic-new-child', runningNotes: 'SYNTHETIC THIRD',
      });
      expect(appendForSqliteTrial(env.db, f.scope, actor, next, left.head.revisionId)).toBe('committed');
      const recycled = await prepareSyntheticRevisionOffer({
        ...f.session, parentRevisionId: next.head.revisionId,
        revisionId: left.head.revisionId, runningNotes: 'SYNTHETIC REUSE ATTEMPT',
      });
      expect(appendForSqliteTrial(env.db, f.scope, actor, recycled, next.head.revisionId)).toBe('conflict');
      expect(current(env.db, f.scope)).toBe(next.head.revisionId);
      expect(count(env.db, 'immutable_revisions', f.scope)).toBe(3);
    } finally { env.close(env.db); }
  });

  it('invalid operation hashes and incompatible schema versions cannot reach SQL writes', async () => {
    const f = await sample(), env = createFixtureDatabase(), actor = 'synthetic-operator';
    try {
      seedGrant(env.db, f.scope, actor);
      expect(appendForSqliteTrial(env.db, f.scope, actor,
        { ...f.base, operationId: 'f'.repeat(64) }, null)).toBe('deny');
      expect(appendForSqliteTrial(env.db, f.scope, actor,
        { ...f.base, head: { ...f.base.head, sessionSchemaVersion: '1.4.0' } } as unknown as SyntheticSyncOffer,
        null)).toBe('deny');
      expect(count(env.db, 'current_heads', f.scope)).toBe(0);
      expect(count(env.db, 'immutable_revisions', f.scope)).toBe(0);
      expect(count(env.db, 'durable_receipts_trial', f.scope)).toBe(0);
    } finally { env.close(env.db); }
  });
});
