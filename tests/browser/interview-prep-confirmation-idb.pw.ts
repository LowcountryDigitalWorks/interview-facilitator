import { expect, test } from '@playwright/test';

/** Separate synthetic-only native IndexedDB transaction proof, not PWA entry. */
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/fixtures/readback.html');
});

test('human-attested private answer persists atomically across synthetic database close/reopen', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, bridge, stage, confirm, trial, hash, display] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/interview-workflow-bridge.ts',
      '/src/interview-prep-staging-overlay.ts', '/src/interview-prep-confirmation-trial.ts',
      '/src/interview-prep-confirmation-idb-trial.ts', '/src/pack-identity.ts',
      '/src/presentation.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC OFFLINE CONFIRMATION',
    }, new Date('2026-11-08T14:00:00.000Z'));
    const packet = {
      schemaVersion: bridge.INTERVIEW_PREP_PACKET_VERSION,
      jobKey: 'synthetic-idb-proof',
      sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      preparedAt: '2026-11-08T14:15:00.000Z',
      candidates: [{
        candidateId: 'c1', questionId: 'primary-goal',
        proposedValue: 'SYNTHETIC PRIVATE SOURCE GUESS',
        sourceSystem: 'authorized-notes', sourceRecordRef: 'PRIVATE TEST SOURCE',
        observedAt: '2026-11-08T14:05:00.000Z', confidence: 'unverified',
      }],
    };
    const digest = (source: unknown) => hash.sha256Hex(hash.canonicalizeJson(
      JSON.parse(JSON.stringify(source)),
    ));
    const proposal = {
      schemaVersion: 'ldw.prep-selection.v1',
      jobKey: packet.jobKey, sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      expectedSessionDigest: await digest(session), expectedPacketDigest: await digest(packet),
      selections: [{ questionId: 'primary-goal', candidateId: 'c1' }],
      notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.',
    };
    const overlay = await stage.stageSelectedInterviewPrepForReview(session, packet, proposal);
    const input = {
      schemaVersion: confirm.PREP_CONFIRMATION_TRIAL_VERSION,
      sessionId: session.sessionId, jobKey: packet.jobKey,
      questionId: 'primary-goal', candidateId: 'c1',
      // Intentionally NOT the pre-interview source guess.
      clientStatement: 'SYNTHETIC CLIENT LIVE CONFIRMED A CORRECTION',
      confirmedAt: '2026-11-08T15:00:00.000Z',
      operatorAttestation: 'client-confirmed-in-interview',
      operatorAcknowledged: true,
    };
    const db = await trial.openConfirmationTrialDatabaseForReview();
    let second: IDBDatabase | null = null;
    try {
      await trial.seedConfirmationTrialForReview(db, session);
      const question = session.packSnapshot.questions.find((q: { id: string }) => q.id === 'primary-goal');
      const before = display.projectSemanticReadBack(question, session.answers['primary-goal']);
      const saved = await confirm.commitClientConfirmedPrepForReview(
        session, packet, overlay, input, trial.confirmationTrialStoreForReview(db),
      );
      const after = await trial.loadConfirmationTrialForReview(db, session.sessionId);
      // A second open tab carries the old revision; replay cannot overwrite.
      second = await trial.openConfirmationTrialDatabaseForReview();
      const stale = await confirm.commitClientConfirmedPrepForReview(
        session, packet, overlay, input, trial.confirmationTrialStoreForReview(second),
      );
      second.close();
      second = null;
      db.close();
      const reopened = await trial.openConfirmationTrialDatabaseForReview();
      const restored = await trial.loadConfirmationTrialForReview(reopened, session.sessionId);
      reopened.close();
      return {
        before,
        savedKind: saved.kind,
        staleKind: stale.kind,
        sourceUnchanged: session.answers['primary-goal'].value === null,
        storedValue: after.answers['primary-goal'].value,
        storedSource: after.answers['primary-goal'].source,
        storedParent: after.parentRevisionId,
        sourceRevision: session.revisionId,
        restoresIdentically: hash.canonicalizeJson(after) === hash.canonicalizeJson(restored),
        hasPrivateSourceRef: hash.canonicalizeJson(restored).includes('PRIVATE TEST SOURCE'),
        hasUnconfirmedGuess: hash.canonicalizeJson(restored).includes('SYNTHETIC PRIVATE SOURCE GUESS'),
      };
    } finally {
      second?.close();
      db.close();
      await trial.deleteConfirmationTrialDatabaseForReview();
    }
  });
  expect(outcome.before).toMatchObject({ valueLabel: 'No answer recorded', statusLabel: 'Open' });
  expect(outcome.savedKind).toBe('saved-private-client-statement');
  expect(outcome.staleKind).toBe('stale-no-write');
  expect(outcome.sourceUnchanged).toBe(true);
  expect(outcome.storedValue).toBe('SYNTHETIC CLIENT LIVE CONFIRMED A CORRECTION');
  expect(outcome.storedSource).toBe('client-statement');
  expect(outcome.storedParent).toBe(outcome.sourceRevision);
  expect(outcome.restoresIdentically).toBe(true);
  expect(outcome.hasPrivateSourceRef).toBe(false);
  expect(outcome.hasUnconfirmedGuess).toBe(false);
});

test('two synthetic tabs competing from same source cannot both overwrite original state', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const [pack, semantic, bridge, stage, confirm, trial, hash] = await Promise.all([
      '/src/pack.ts', '/src/semantic-session.ts', '/src/interview-workflow-bridge.ts',
      '/src/interview-prep-staging-overlay.ts', '/src/interview-prep-confirmation-trial.ts',
      '/src/interview-prep-confirmation-idb-trial.ts', '/src/pack-identity.ts',
    ].map(load));
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'SYNTHETIC CONCURRENT TABS',
    }, new Date('2026-11-08T14:00:00.000Z'));
    const packet = {
      schemaVersion: bridge.INTERVIEW_PREP_PACKET_VERSION,
      jobKey: 'synthetic-concurrent',
      sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      preparedAt: '2026-11-08T14:30:00.000Z',
      candidates: [{
        candidateId: 'a', questionId: 'must-have', proposedValue: 'SYNTHETIC PRIVATE REQUIREMENT',
        sourceSystem: 'client-ops', sourceRecordRef: 'SYNTHETIC PRIVATE REF',
        observedAt: '2026-11-08T14:05:00.000Z', confidence: 'unverified',
      }],
    };
    const digest = (value: unknown) => hash.sha256Hex(hash.canonicalizeJson(
      JSON.parse(JSON.stringify(value)),
    ));
    const selection = {
      schemaVersion: 'ldw.prep-selection.v1',
      jobKey: packet.jobKey, sessionId: session.sessionId,
      expectedRevisionId: session.revisionId,
      expectedPackDigest: session.packIdentity.digest,
      expectedSessionDigest: await digest(session), expectedPacketDigest: await digest(packet),
      selections: [{ questionId: 'must-have', candidateId: 'a' }],
      notice: 'Selections are proposals for client confirmation, not accepted answers or workflow actions.',
    };
    const overlay = await stage.stageSelectedInterviewPrepForReview(session, packet, selection);
    const input = {
      schemaVersion: confirm.PREP_CONFIRMATION_TRIAL_VERSION,
      sessionId: session.sessionId, jobKey: packet.jobKey,
      questionId: 'must-have', candidateId: 'a',
      clientStatement: 'SYNTHETIC CUSTOMER CONFIRMED',
      confirmedAt: '2026-11-08T15:00:00.000Z',
      operatorAttestation: 'client-confirmed-in-interview',
      operatorAcknowledged: true,
    };
    const first = await trial.openConfirmationTrialDatabaseForReview();
    const other = await trial.openConfirmationTrialDatabaseForReview();
    try {
      await trial.seedConfirmationTrialForReview(first, session);
      const [a, b] = await Promise.all([
        confirm.commitClientConfirmedPrepForReview(
          session, packet, overlay, input, trial.confirmationTrialStoreForReview(first)),
        confirm.commitClientConfirmedPrepForReview(
          session, packet, overlay, input, trial.confirmationTrialStoreForReview(other)),
      ]);
      const stored = await trial.loadConfirmationTrialForReview(first, session.sessionId);
      return {
        results: [a.kind, b.kind].sort(),
        sourceParent: session.revisionId,
        storedParent: stored.parentRevisionId,
        storedValue: stored.answers['must-have'].value,
      };
    } finally {
      first.close();
      other.close();
      await trial.deleteConfirmationTrialDatabaseForReview();
    }
  });
  expect(result.results).toEqual(['saved-private-client-statement', 'stale-no-write']);
  expect(result.storedParent).toBe(result.sourceParent);
  expect(result.storedValue).toBe('SYNTHETIC CUSTOMER CONFIRMED');
});

test('synthetic DB refuses real-looking client data before any write', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const [pack, semantic, trial] = await Promise.all([
      import('/src/pack.ts'), import('/src/semantic-session.ts'),
      import('/src/interview-prep-confirmation-idb-trial.ts'),
    ]);
    const session = await semantic.createSemanticSession(pack.generalDiscoveryPack, {
      clientLabel: 'UNAUTHORIZED REAL ENGAGEMENT',
    }, new Date('2026-11-08T14:00:00.000Z'));
    const db = await trial.openConfirmationTrialDatabaseForReview();
    let blocked = false;
    try {
      await trial.seedConfirmationTrialForReview(db, session);
    } catch { blocked = true; }
    const missing = await trial.loadConfirmationTrialForReview(db, session.sessionId);
    db.close();
    await trial.deleteConfirmationTrialDatabaseForReview();
    return { blocked, absent: missing === undefined };
  });
  expect(result).toEqual({ blocked: true, absent: true });
});
