import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';
import type { InterviewSession } from '../../src/domain';
import { canonicalizeJson, sha256Hex } from '../../src/pack-identity';
import { validateSemanticSessionRecord, type SemanticInterviewSession } from '../../src/semantic-session';
import { migrateSemantic13ToKnownFact14 } from '../../src/known-fact-session';
import { syntheticPinned12Session, syntheticSemanticSession } from './synthetic-session';

async function readDownloadJson(download: Download): Promise<unknown> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download stream unavailable.');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk as Uint8Array, { stream: true });
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

const DB_NAME = 'ldw-interview-facilitator';
const STORE = 'sessions';

async function clearLocalState(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async ({ dbName }) => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }, { dbName: DB_NAME });
}

async function putRawSession(page: Page, row: unknown): Promise<void> {
  await page.evaluate(async ({ dbName, store, row }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 4);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'sessionId' });
        if (!request.result.objectStoreNames.contains('legacy-session-archive')) request.result.createObjectStore('legacy-session-archive');
        if (!request.result.objectStoreNames.contains('revision-history')) request.result.createObjectStore('revision-history');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { dbName: DB_NAME, store: STORE, row });
}

async function readStorageSnapshot(page: Page): Promise<{ rows: unknown[]; archives: unknown[]; archiveKeys: IDBValidKey[] }> {
  return page.evaluate(async ({ dbName }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['sessions', 'legacy-session-archive'], 'readonly');
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const rowsRequest = transaction.objectStore('sessions').getAll();
    const archivesRequest = transaction.objectStore('legacy-session-archive').getAll();
    const archiveKeysRequest = transaction.objectStore('legacy-session-archive').getAllKeys();
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [rows, archives, archiveKeys] = await Promise.all([
      read(rowsRequest),
      read(archivesRequest),
      read(archiveKeysRequest),
    ]);
    await completed;
    db.close();
    return { rows, archives, archiveKeys };
  }, { dbName: DB_NAME });
}

function syntheticSession(sessionId = 'synthetic-valid-session'): Promise<SemanticInterviewSession> {
  return syntheticSemanticSession({ sessionId });
}

test.beforeEach(async ({ page }) => {
  await clearLocalState(page);
});

test('Home distinguishes a legitimate empty database and meets the initial axe floor', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No saved interviews yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();

  const results = await new AxeBuilder({ page }).analyze();
  const consequential = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(consequential).toEqual([]);
});

test('Prepare exposes pinned pack, reference provenance and distinct readiness without auto-accepting facts', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();

  await expect(page.getByRole('heading', { name: 'Prepare this interview' })).toBeVisible();
  await expect(page.locator('[data-prepare-pack-title]')).toHaveText('General discovery');
  await expect(page.locator('#interview-pack')).toHaveValue('general-discovery-blank');
  const context = page.getByRole('region', { name: 'Known context for review' });
  await expect(context).toContainText('No client-specific information has been preloaded');
  await expect(context).toContainText('No known context supplied with this pack');
  await expect(context).not.toContainText('Synthetic pre-interview research');

  const readiness = page.getByRole('region', { name: 'Before you start' });
  await expect(readiness.locator('[data-prepare-save]')).toContainText('Not saved yet');
  await expect(readiness.locator('[data-prepare-offline]')).toContainText(/offline shell ready|Offline readiness has not been confirmed/);
  await expect(readiness.locator('[data-prepare-storage]')).toContainText(/protected storage|Best effort|Protection not yet checked/);
  await expect(readiness).toContainText('Export JSON backup');
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);

  await page.getByLabel('Project or client label').fill('Synthetic Prepare Check');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?', level: 1 })).toBeVisible();
  const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  const stored = rows.find((item) => item.clientLabel === 'Synthetic Prepare Check');
  expect(stored).toBeDefined();
  expect(stored?.answers['existing-presence']).toMatchObject({
    value: null, resolution: 'unresolved', source: null, confirmation: null,
  });
  expect(stored?.knownFacts).toEqual([]);
  expect(stored?.interviewPackId).toBe('general-discovery-blank');
});

const livePackChoices = [
  { id: 'website-greenfield', title: 'New website / online presence', first: 'What should the website accomplish for the business?' },
  { id: 'website-takeover', title: 'Existing website / platform takeover', first: 'What website, platform or digital property exists today?' },
  { id: 'workflow-automation', title: 'Workflow / automation', first: 'What result should this workflow reliably produce?' },
  { id: 'technology-ownership', title: 'Technology / ownership review', first: 'Which business services or capabilities depend on this technology?' },
] as const;

for (const choice of livePackChoices) {
  test(`New interview selects ${choice.id} and pins a clean offline pack`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New interview' }).click();
    const selector = page.getByRole('combobox', { name: 'Interview type' });
    await selector.selectOption(choice.id);
    await expect(page.locator('[data-prepare-pack-title]')).toHaveText(choice.title);
    await expect(page.locator('[data-prepare-pack-summary]')).toContainText('guided questions');
    await expect(page.getByRole('region', { name: 'Known context for review' }))
      .toContainText('No known context supplied with this pack');
    await page.getByLabel('Project or client label').fill('SYNTHETIC ' + choice.id);
    await page.getByRole('button', { name: 'Start interview' }).click();
    await expect(page.getByRole('heading', { name: choice.first, level: 1 })).toBeVisible();
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.interviewPackId).toBe(choice.id);
    expect(rows[0]?.packSnapshot.title).toBe(choice.title);
    expect(rows[0]?.knownFacts).toEqual([]);
    expect(Object.values(rows[0]!.answers).every(answer =>
      answer.value === null && answer.source === null && answer.resolution === 'unresolved'
    )).toBe(true);
  });
}

test('private follow-up capture exports validated action proposals but never turns them into client presentation or tasks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC FOLLOW-UP EXPORT');
  await page.getByRole('button', { name: 'Start interview' }).click();

  const action = 'SYNTHETIC PRIVATE <img src=x onerror=alert(1)> Review account ownership';
  const owner = 'SYNTHETIC OWNER <svg onload=alert(1)>';
  const dueDate = '2026-12-20';
  await page.getByLabel('Proposed follow-up action').fill(action);
  await page.getByLabel('Suggested owner').fill(owner);
  await page.getByLabel('Suggested due date').fill(dueDate);
  await page.locator('#question-note').fill('SYNTHETIC INTERVIEWER NOTE EXCLUDED FROM ACTIONS');
  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });
  // The Save label can be satisfied by an earlier operation. Inspect the
  // authoritative IndexedDB row before closing the page to prove durability.
  await expect.poll(async () => {
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return rows.find(x => x.clientLabel === 'SYNTHETIC FOLLOW-UP EXPORT')
      ?.answers['existing-presence']?.followUp?.action;
  }, { timeout: 10_000 }).toBe(action);

  // Reopening proves the new private field is in the existing local
  // canonical session and not just transient DOM state.
  await page.reload();
  await page.getByRole('button', { name: /SYNTHETIC FOLLOW-UP EXPORT/ }).click();
  await expect(page.getByLabel('Proposed follow-up action')).toHaveValue(action);
  await expect(page.getByLabel('Suggested owner')).toHaveValue(owner);
  await expect(page.getByLabel('Suggested due date')).toHaveValue(dueDate);
  const stored = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  const persisted = stored.find(x => x.clientLabel === 'SYNTHETIC FOLLOW-UP EXPORT');
  expect(persisted?.answers['existing-presence']?.followUp).toEqual({ action, owner, dueDate });
  expect(persisted?.answers['existing-presence']?.resolution).toBe('unresolved');

  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByText('Proposed next steps — internal only')).toHaveCount(0);
  await expect(page.locator('[data-action="next-step-proposals"]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(action);

  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const region = page.getByRole('region', { name: 'Proposed next steps — internal only' });
  await expect(region).toContainText(action);
  await expect(region.locator('img, svg')).toHaveCount(0);
  await expect(region).toContainText('Proposed owner: ' + owner);
  await expect(region).toContainText('Suggested due: ' + dueDate);
  await expect(region).toContainText('not approved tasks');
  const downloading = page.waitForEvent('download');
  await region.getByRole('button', { name: 'Export proposed next steps JSON (private)' }).click();
  const artifact = await downloading;
  expect(artifact.suggestedFilename()).toBe('interview-next-step-proposals-private.json');
  const json = await readDownloadJson(artifact) as {
    schemaVersion: string; kind: string; sessionId: string; revisionId: string;
    items: Array<{ questionId: string; action: string; owner?: string; dueDate?: string }>; notice: string;
  };
  expect(json.kind).toBe('private-human-review-only');
  expect(json.schemaVersion).toBe('ldw.interview-next-steps.v1');
  expect(json.items).toEqual([{ questionId: 'existing-presence', action, owner, dueDate }]);
  expect(json.notice).toContain('no task');
  expect(JSON.stringify(json)).not.toContain('INTERVIEWER NOTE EXCLUDED');

  await page.getByRole('button', { name: 'Presentation view', exact: true }).click();
  await expect(page.getByText('Proposed next steps — internal only')).toHaveCount(0);
  await expect(page.locator('[data-action="next-step-proposals"]')).toHaveCount(0);
});

test('empty action drafts do not export and clearing a follow-up removes its saved proposal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC EMPTY ACTION');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.getByLabel('Proposed follow-up action').fill('SYNTHETIC TEMPORARY ACTION');
  await page.getByLabel('Suggested owner').fill('SYNTHETIC TEAM');
  await page.getByLabel('Suggested due date').fill('2026-12-31');
  await page.getByLabel('Proposed follow-up action').fill('   ');
  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const region = page.getByRole('region', { name: 'Proposed next steps — internal only' });
  await expect(region).toContainText('No currently relevant follow-up proposals recorded.');
  await expect(region.getByRole('button', { name: 'Export proposed next steps JSON (private)' })).toBeDisabled();
  const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  expect(rows[0]?.answers['existing-presence']?.followUp).toBeNull();
});

test('pending conditional action remains private and is excluded until its question becomes relevant', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Interview type').selectOption('website-greenfield');
  await page.getByLabel('Project or client label').fill('SYNTHETIC CONDITIONAL ACTION');
  await page.getByRole('button', { name: 'Start interview' }).click();

  const draft = 'SYNTHETIC PRIVATE PENDING BOOKING FOLLOW-UP';
  await page.locator('[data-question-id="booking-details"]').click();
  await page.getByLabel('Proposed follow-up action').fill(draft);
  await expect(page.locator('#follow-up-help')).toContainText('conditional question is pending');
  await expect.poll(async () => {
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return rows[0]?.answers['booking-details']?.followUp?.action;
  }).toBe(draft);
  await page.locator('[data-question-id="success-measure"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const review = page.getByRole('region', { name: 'Proposed next steps — internal only' });
  await expect(review).toContainText('1 draft action(s)');
  await expect(review).not.toContainText(draft);
  await expect(review.getByRole('button', { name: 'Export proposed next steps JSON (private)' }))
    .toBeDisabled();

  // Explicitly make the branch relevant, without treating the retained draft
  // as a captured answer or a customer-approved workflow action.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: /SYNTHETIC CONDITIONAL ACTION/ }).click();
  await page.locator('[data-question-id="needs-booking"]').click();
  await page.getByRole('radio', { name: 'Yes', exact: true }).check();
  await page.locator('[data-question-id="success-measure"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const activeReview = page.getByRole('region', { name: 'Proposed next steps — internal only' });
  await expect(activeReview).toContainText(draft);
  await expect(activeReview).toContainText('not approved tasks');
});

test('legacy non-ISO follow-up due date survives unrelated edits and autosave', async ({ page }) => {
  const legacy = await syntheticSession('synthetic-legacy-date');
  legacy.clientLabel = 'SYNTHETIC LEGACY DUE DATE';
  legacy.answers['existing-presence']!.followUp = {
    action: 'SYNTHETIC LEGACY TASK DRAFT',
    dueDate: 'after owner handover / TBD',
    owner: 'SYNTHETIC TEAM',
  };
  await page.goto('/');
  await putRawSession(page, legacy);
  await page.reload();
  await page.getByRole('button', { name: /SYNTHETIC LEGACY DUE DATE/ }).click();
  const dueField = page.getByLabel('Suggested due date');
  await expect(dueField).toHaveValue('after owner handover / TBD');
  await page.locator('#question-note').fill('SYNTHETIC UNRELATED NOTES CHANGE');
  await expect.poll(async () => {
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return rows[0]?.answers['existing-presence']?.note;
  }).toBe('SYNTHETIC UNRELATED NOTES CHANGE');
  await page.reload();
  await page.getByRole('button', { name: /SYNTHETIC LEGACY DUE DATE/ }).click();
  await expect(dueField).toHaveValue('after owner handover / TBD');
  const saved = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  expect(saved[0]?.answers['existing-presence']?.followUp).toEqual({
    action: 'SYNTHETIC LEGACY TASK DRAFT',
    dueDate: 'after owner handover / TBD',
    owner: 'SYNTHETIC TEAM',
  });
});

test('private handoff export bundles pinned canonical interview, confidential notes and human-only next steps', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC PRIVATE BUNDLE');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.getByLabel('Proposed follow-up action').fill('SYNTHETIC DRAFT REVIEW SCOPED WORK');
  await page.getByLabel('Suggested owner').fill('SYNTHETIC INTERNAL REVIEWER');
  await page.getByLabel('Suggested due date').fill('after synthetic approval');
  await page.locator('#question-note').fill('SYNTHETIC CONFIDENTIAL NOTE IN BUNDLE ONLY');
  await page.locator('#running-notes').fill('SYNTHETIC PARKING LOT PRIVATE');
  await expect.poll(async () => {
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return rows[0]?.answers['existing-presence']?.followUp?.action;
  }).toBe('SYNTHETIC DRAFT REVIEW SCOPED WORK');
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  // Initial presentation mode must never expose internal bundle controls.
  await expect(page.getByRole('button', { name: 'Export private handoff bundle JSON' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const handoff = page.getByRole('button', { name: 'Export private handoff bundle JSON' });
  await expect(handoff).toBeVisible();
  const started = page.waitForEvent('download');
  await handoff.click();
  const download = await started;
  expect(download.suggestedFilename()).toBe('interview-private-handoff.json');
  const bundle = await readDownloadJson(download) as {
    schemaVersion: string; kind: string; notice: string;
    source: { sessionId: string; revisionId: string; packDigest: string; canonicalSha256: string };
    canonicalSession: SemanticInterviewSession;
    internalMarkdown: string;
    proposedNextSteps: { kind: string; items: Array<{ questionId: string; action: string; owner?: string; dueDate?: string }> };
  };
  expect(bundle.schemaVersion).toBe('ldw.interview-private-handoff.v1');
  expect(bundle.kind).toBe('private-human-review-only');
  expect(bundle.source.sessionId).toBe(bundle.canonicalSession.sessionId);
  expect(bundle.source.revisionId).toBe(bundle.canonicalSession.revisionId);
  expect(bundle.source.packDigest).toBe(bundle.canonicalSession.packIdentity.digest);
  expect(bundle.source.canonicalSha256)
    .toBe(await sha256Hex(canonicalizeJson(bundle.canonicalSession)));
  expect(bundle.canonicalSession.clientLabel).toBe('SYNTHETIC PRIVATE BUNDLE');
  expect(bundle.canonicalSession.answers['existing-presence']!.note)
    .toBe('SYNTHETIC CONFIDENTIAL NOTE IN BUNDLE ONLY');
  expect(bundle.internalMarkdown).toContain('SYNTHETIC PARKING LOT PRIVATE');
  expect(bundle.proposedNextSteps.kind).toBe('private-human-review-only');
  expect(bundle.proposedNextSteps.items).toEqual([{
    questionId: 'existing-presence',
    action: 'SYNTHETIC DRAFT REVIEW SCOPED WORK',
    owner: 'SYNTHETIC INTERNAL REVIEWER',
    dueDate: 'after synthetic approval',
  }]);
  expect(JSON.stringify(bundle.proposedNextSteps)).not.toContain('CONFIDENTIAL NOTE IN BUNDLE');
  expect(bundle.notice).toContain('not a task approval');
  await page.getByRole('button', { name: 'Presentation view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export private handoff bundle JSON' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('SYNTHETIC CONFIDENTIAL NOTE IN BUNDLE');
});

test('rapid private handoff clicks create only one local download and leave the button usable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC SINGLE EXPORT');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const button = page.getByRole('button', { name: 'Export private handoff bundle JSON' });
  await expect(button).toBeEnabled();
  const downloads: Download[] = [];
  page.on('download', (artifact) => downloads.push(artifact));
  // Fire twice in ONE browser turn: the first async handler must acquire its
  // guard synchronously before the second click can start another export.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-action="handoff"]');
    if (!button) throw new Error('Private export control was not rendered.');
    button.click();
    button.click();
  });
  await expect.poll(() => downloads.length).toBe(1);
  await expect(button).toBeEnabled();
  await page.waitForTimeout(250);
  expect(downloads).toHaveLength(1);
  expect(downloads[0]?.suggestedFilename()).toBe('interview-private-handoff.json');
  const bundle = await readDownloadJson(downloads[0]!);
  expect((bundle as { canonicalSession: SemanticInterviewSession }).canonicalSession.clientLabel)
    .toBe('SYNTHETIC SINGLE EXPORT');
});

test('private handoff busy state survives a Review re-render and clears on current control', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC RE-RENDER BUSY');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();

  const downloads: Download[] = [];
  page.on('download', artifact => downloads.push(artifact));
  const during = await page.evaluate(() => {
    const first = document.querySelector<HTMLButtonElement>('[data-action="handoff"]');
    if (!first) throw new Error('Private handoff button unavailable.');
    // Begin async export, then synchronously rebuild the Review view via
    // Presentation -> private. No microtask can finish the export between
    // these operations in the same browser JavaScript turn.
    first.click();
    document.querySelector<HTMLButtonElement>('[data-action="enter-presentation"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="exit-presentation"]')?.click();
    const current = document.querySelector<HTMLButtonElement>('[data-action="handoff"]');
    return {
      replaced: Boolean(current && current !== first),
      disabled: current?.disabled ?? false,
      busy: current?.getAttribute('aria-busy'),
    };
  });
  expect(during).toEqual({ replaced: true, disabled: true, busy: 'true' });
  const currentButton = page.getByRole('button', { name: 'Export private handoff bundle JSON' });
  await expect.poll(() => downloads.length).toBe(1);
  await expect(currentButton).toBeEnabled();
  await expect(currentButton).not.toHaveAttribute('aria-busy', 'true');
  expect(downloads).toHaveLength(1);
  expect((await readDownloadJson(downloads[0]!)) as { canonicalSession: SemanticInterviewSession })
    .toMatchObject({ canonicalSession: { clientLabel: 'SYNTHETIC RE-RENDER BUSY' } });
});

test('private handoff is available for a clean interview without inventing next-step tasks', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('SYNTHETIC ZERO TASK HANDOFF');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('[data-question-id="must-have"]').click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export private handoff bundle JSON' }).click();
  const bundle = await readDownloadJson(await started) as {
    canonicalSession: SemanticInterviewSession;
    proposedNextSteps: { items: unknown[] };
  };
  expect(bundle.canonicalSession.clientLabel).toBe('SYNTHETIC ZERO TASK HANDOFF');
  expect(bundle.proposedNextSteps.items).toEqual([]);
});

test('one malformed IndexedDB row does not hide a healthy local interview', async ({ page }) => {
  await page.goto('/');
  await putRawSession(page, await syntheticSession());
  await putRawSession(page, { sessionId: 'synthetic-malformed-session', updatedAt: null });
  await page.reload();

  await expect(page.getByRole('button', { name: /Synthetic Browser Test/ })).toBeVisible();
  await expect(page.getByText('1 local interview could not be read.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Import session JSON' })).toBeEnabled();
});

test('validated 1.4 local interview is read-only and exports full canonical evidence without modifying storage', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-readonly-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();

  await expect(page.getByText('Synthetic Browser Test — 1.4 interview (read-only)')).toBeVisible();
  await expect(page.getByText('No saved interviews yet.')).toHaveCount(0);
  await expect(page.locator('[data-session-id="synthetic-readonly-14"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New interview' })).toBeEnabled();

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  const artifact = await downloadStarted;
  expect(artifact.suggestedFilename()).toContain('-1.4-backup.json');
  expect(await artifact.failure()).toBeNull();
  const exported = await readDownloadJson(artifact) as unknown;
  expect(exported).toEqual(source14);
  expect((exported as typeof source14).knownFactLedger).toEqual(source14.knownFactLedger);

  const stored = await readStorageSnapshot(page);
  expect(stored.rows).toEqual([source14]);
  expect(stored.archives).toEqual([]);
});


test('1.4 home warning is explicit about this build not restoring a 1.4 JSON backup', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-warning-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByText('Editing and importing 1.4 JSON are not supported in this build.', { exact: false })).toBeVisible();
  await expect(page.getByText('this build cannot restore that backup', { exact: false })).toBeVisible();
  expect((await readStorageSnapshot(page)).rows).toEqual([source14]);
});

test('1.4 export refuses a stale deleted row and explains disappearance without mutating storage', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-disappeared-14'));
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Export full 1.4 JSON backup' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ldw-interview-facilitator', 4);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete('synthetic-disappeared-14');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  await expect(page.getByText('This 1.4 interview is no longer on this device', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export full 1.4 JSON backup' })).toHaveCount(0);
  expect((await readStorageSnapshot(page)).rows).toEqual([]);
});

test('hostile 1.4 client labels are rendered as text and downloaded under a sanitized filename', async ({ page }) => {
  const source14 = await migrateSemantic13ToKnownFact14(await syntheticSession('synthetic-hostile-label-14'));
  source14.clientLabel = '<img src=x onerror=alert(1)>';
  await page.goto('/');
  await putRawSession(page, source14);
  await page.reload();
  await expect(page.getByText('<img src=x onerror=alert(1)> — 1.4 interview (read-only)')).toBeVisible();
  await expect(page.locator('.session-list img')).toHaveCount(0);
  const started = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full 1.4 JSON backup' }).click();
  const artifact = await started;
  expect(artifact.suggestedFilename()).toMatch(/^[a-z0-9-]+-1\.4-backup\.json$/);
  expect(artifact.suggestedFilename()).not.toContain('<');
  expect(await readDownloadJson(artifact)).toEqual(source14);
  expect((await readStorageSnapshot(page)).rows).toEqual([source14]);
});

test('answer, question note, and running note keep focus and selection through autosave', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Focus Test');
  await page.getByRole('button', { name: 'Start interview' }).click();

  for (const selector of ['#answer', '#question-note', '#follow-up-action', '#follow-up-owner', '#running-notes']) {
    const field = page.locator(selector);
    await field.fill('abcdefghij');
    await field.focus();
    await field.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(2, 7));
    await page.waitForTimeout(260);
    await expect(field).toBeFocused();
    const selection = await field.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    }));
    expect(selection).toEqual({ start: 2, end: 7 });
  }

  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/);
});

test('mobile Quick capture autosaves out-of-order notes without changing coverage or Presentation disclosure', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startFreshInterview(page, 'Synthetic Quick Capture');
  const quick = page.getByRole('region', { name: 'Quick capture' });
  const parkingNotes = page.locator('#running-notes');
  const note = 'Synthetic out-of-order follow-up: ask about access ownership.';

  await expect(quick).toBeVisible();
  await expect(quick).toContainText('do not count toward coverage');
  await expect(quick).toContainText('stay private in Presentation view');
  await expect(parkingNotes).toBeVisible();
  await expect(page.locator('#context-mobile-panel #running-notes')).toHaveCount(0);
  await expect(page.locator('[data-coverage-mobile]')).toHaveText('Coverage 0/5');

  await parkingNotes.fill(note);
  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });
  await expect(page.locator('[data-coverage-mobile]')).toHaveText('Coverage 0/5');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(parkingNotes).toHaveValue(note);
  // Continue also schedules a save; prove the IndexedDB record is durable
  // before simulating a reload rather than trusting a previous "Saved" label.
  await expect.poll(async () => {
    const stored = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return stored.find((item) => item.clientLabel === 'Synthetic Quick Capture')?.runningNotes;
  }).toBe(note);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Quick Capture/ }).click();
  await expect(parkingNotes).toHaveValue(note);
  const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  const saved = rows.find((item) => item.clientLabel === 'Synthetic Quick Capture');
  expect(saved?.runningNotes).toBe(note);
  expect(saved?.answers['existing-presence']?.resolution).toBe('unresolved');

  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1);

  await page.getByRole('button', { name: 'Presentation view' }).click();
  await expect(page.locator('#running-notes')).toHaveCount(0);
  await expect(page.getByText(note)).toHaveCount(0);
  await advanceToQuestion(page, 'What absolutely has to be true for the first version to feel successful?');
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByText(note)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
});

test('an already-cached production shell reloads while offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'New interview' })).toBeVisible();
  await expect(page.getByText(/Offline/)).toBeVisible();
});

test('Presentation read-back stays public across Change and masks retained deferred values', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-presentation-session');
  row.currentQuestionId = 'must-have';
  row.answers['existing-presence'] = { value: 'stale internal detail', resolution: 'deferred', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: 'private question note' };
  row.answers['primary-goal'] = { value: 'stale not-applicable detail', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
  row.answers['must-have'] = { value: 'Public launch requirement', resolution: 'captured', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
  row.runningNotes = 'private running note';
  await putRawSession(page, row);
  await page.reload();

  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByText('Question notes')).toHaveCount(0);
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('Question status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export backup' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByText('Presentation read-back')).toBeVisible();
  await expect(page.getByText('Deferred / not captured')).toBeVisible();
  await expect(page.getByText('Not applicable').first()).toBeVisible();
  await expect(page.getByText('stale internal detail')).toHaveCount(0);
  await expect(page.getByText('stale not-applicable detail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await expect(page.getByText('private running note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export internal Markdown' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete local session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Home' })).toHaveCount(0);
  await expect(page.getByText(/cannot guarantee that free-text answers themselves contain no sensitive information/)).toBeVisible();

  const readBackAxe = await new AxeBuilder({ page }).analyze();
  const readBackConsequential = readBackAxe.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(readBackConsequential).toEqual([]);

  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await expect(change).toBeVisible();
  await change.click();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByText('Question notes')).toHaveCount(0);
  await expect(page.locator('.context-rail')).toHaveCount(0);

});

test('Read-back Change returns to the originating row and preserves Presentation disclosure boundary', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-change-return-presentation');
  row.currentQuestionId = 'must-have';
  row.answers['existing-presence'] = {
    value: 'Previously agreed synthetic detail', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: 'private question note',
  };
  row.runningNotes = 'private running note';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await change.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await page.locator('#answer').fill('Updated public synthetic detail');

  await page.getByRole('button', { name: 'Return to Read-back' }).click();
  await expect(change).toBeFocused();
  await expect(page.locator('.summary-row', { hasText: 'What is already in place today?' }))
    .toContainText('Updated public synthetic detail');
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.locator('.context-rail')).toHaveCount(0);
  await expect(page.getByText('private question note')).toHaveCount(0);
  await expect(page.getByText('private running note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
});

test('Change and Return to Read-back work on a 320px phone without stale return controls', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startFreshInterview(page, 'Synthetic Phone Read-back');
  await advanceToQuestion(page, 'What absolutely has to be true for the first version to feel successful?');
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const change = page.getByRole('button', { name: 'Change What is already in place today?' });
  await change.click();

  const returnButton = page.getByRole('button', { name: 'Return to Read-back' });
  await expect(returnButton).toBeVisible();
  await page.locator('#answer').fill('Synthetic mobile correction');
  await returnButton.click();
  await expect(change).toBeFocused();
  await expect(page.locator('.summary-row', { hasText: 'What is already in place today?' }))
    .toContainText('Synthetic mobile correction');
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

  await page.getByRole('button', { name: 'Return to interview' }).click();
  await expect(page.getByRole('button', { name: 'Return to Read-back' })).toHaveCount(0);
});

test('Read-back correction focuses heading if parent answer hides originating conditional row', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-conditional-return-focus');
  row.currentQuestionId = 'booking-process';
  row.answers['needs-booking'] = {
    value: 'Yes', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: '',
  };
  row.answers['booking-process'] = {
    value: 'Synthetic booking detail', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: 'private scheduling note',
  };
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  // The saved session resumes at the conditional question; advance through Wrap-up first.
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  await page.getByRole('button', { name: 'Change How should booking or scheduling work?' }).click();
  await expect(page.getByRole('button', { name: 'Return to Read-back' })).toBeVisible();
  await page.locator('[data-action="back"]').click();
  await expect(page.getByRole('heading', { name: 'Do people need to request or book time?', level: 1 })).toBeVisible();
  await page.getByRole('radio', { name: 'No', exact: true }).check();
  await page.getByRole('button', { name: 'Return to Read-back' }).click();

  await expect(page.locator('#review-title')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Change How should booking or scheduling work?' })).toHaveCount(0);
  await expect(page.locator('.summary-row', { hasText: 'Do people need to request or book time?' })).toContainText('No');
  await expect(page.getByText('private scheduling note')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export full JSON backup' })).toHaveCount(0);
  await expect(page.locator('.context-rail')).toHaveCount(0);
});

async function startFreshInterview(page: Page, clientLabel = 'Synthetic Browser Test'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(clientLabel);
  await page.getByRole('button', { name: 'Start interview' }).click();
}

async function advanceToQuestion(page: Page, prompt: string): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (await page.getByRole('heading', { name: prompt, level: 1 }).isVisible()) return;
    const continueButton = page.getByRole('button', { name: 'Continue' });
    if (!(await continueButton.isEnabled())) break;
    await continueButton.click();
  }
}

test('pending conditional evidence is read back as Open rather than Current', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-pending-readback');
  row.currentQuestionId = 'must-have';
  row.answers['needs-booking'] = {
    value: 'Yes', resolution: 'not-applicable', source: 'client-statement', needsConfirmation: false,
    confirmation: null, followUp: null, note: '',
  };
  row.answers['booking-process'] = {
    value: 'Retained pending booking detail', resolution: 'captured', source: 'client-statement', needsConfirmation: false,
    confirmation: null, followUp: null, note: '',
  };
  await putRawSession(page, row);
  await page.reload();

  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();

  const presentationRow = page.locator('.summary-row', { hasText: 'How should booking or scheduling work?' });
  await expect(presentationRow).toContainText('Retained pending booking detail');
  await expect(presentationRow.locator('small')).toHaveText('Open');
  await expect(presentationRow.locator('small')).not.toHaveText('Current');

  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const privateRow = page.locator('.summary-row', { hasText: 'How should booking or scheduling work?' });
  await expect(privateRow.locator('small')).toHaveText('Open');
});

test('Interview cockpit meets axe floor on the active question view', async ({ page }) => {
  await startFreshInterview(page);
  const results = await new AxeBuilder({ page }).analyze();
  const consequential = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(consequential).toEqual([]);
});

test('textarea answer exposes prompt and helper in its accessible name and description', async ({ page }) => {
  await startFreshInterview(page);
  const answer = page.locator('#answer');
  await expect(answer).toHaveAccessibleName('What is already in place today?');
  await expect(answer).toHaveAccessibleDescription('Confirm the known context or capture what has changed.');
});

test('render boundary preflight retains answer node, focus and caret during synthetic IME input and autosave', async ({ page }) => {
  await startFreshInterview(page, 'Synthetic IME Boundary');
  const answer = page.locator('#answer');
  await answer.fill('abcdefghij');
  await answer.focus();
  await answer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer = field;
    field.setSelectionRange(2, 7);
    // Synthetic composition events test the DOM render boundary, not physical keyboard IME compatibility.
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertCompositionText', data: 'あ', isComposing: true,
    }));
  });

  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });
  const snapshot = await page.evaluate(() => {
    const original = (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer;
    const current = document.querySelector<HTMLTextAreaElement>('#answer');
    return {
      sameNode: original === current,
      connected: original?.isConnected ?? false,
      focused: document.activeElement === current,
      value: current?.value,
      selectionStart: current?.selectionStart,
      selectionEnd: current?.selectionEnd,
    };
  });
  expect(snapshot).toEqual({
    sameNode: true, connected: true, focused: true,
    value: 'abcdefghij', selectionStart: 2, selectionEnd: 7,
  });
  await answer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
  });
  await expect(answer).toBeFocused();
});

test('render boundary preflight preserves capture and context nodes across status and note updates', async ({ page }) => {
  await startFreshInterview(page, 'Synthetic Context Boundary');
  const answer = page.locator('#answer');
  const runningNotes = page.locator('#running-notes');
  await answer.fill('Existing synthetic context');
  await answer.evaluate((element) => {
    const field = element as HTMLTextAreaElement;
    field.setSelectionRange(4, 9);
    (window as Window & { __ldw36Answer?: HTMLTextAreaElement }).__ldw36Answer = field;
  });
  await runningNotes.evaluate((element) => {
    (window as Window & { __ldw36Running?: HTMLTextAreaElement }).__ldw36Running = element as HTMLTextAreaElement;
  });

  await page.locator('label.status-chip', { hasText: 'N/A' }).click();
  await expect(page.locator('[data-coverage-resolved]')).toContainText('1 N/A');
  await page.locator('#question-note').fill('Synthetic private question note');
  await runningNotes.fill('Synthetic private running note');
  await expect(page.locator('[data-save-indicator]')).toContainText(/Saved/, { timeout: 5000 });

  const snapshot = await page.evaluate(() => {
    const windowRefs = window as Window & {
      __ldw36Answer?: HTMLTextAreaElement;
      __ldw36Running?: HTMLTextAreaElement;
    };
    const currentAnswer = document.querySelector<HTMLTextAreaElement>('#answer');
    const currentRunning = document.querySelector<HTMLTextAreaElement>('#running-notes');
    return {
      sameAnswer: windowRefs.__ldw36Answer === currentAnswer,
      sameRunning: windowRefs.__ldw36Running === currentRunning,
      focusedRunning: document.activeElement === currentRunning,
      answerValue: currentAnswer?.value,
      answerSelectionStart: currentAnswer?.selectionStart,
      answerSelectionEnd: currentAnswer?.selectionEnd,
      questionNote: document.querySelector<HTMLTextAreaElement>('#question-note')?.value,
      runningNote: currentRunning?.value,
    };
  });
  expect(snapshot).toEqual({
    sameAnswer: true, sameRunning: true, focusedRunning: true,
    answerValue: 'Existing synthetic context', answerSelectionStart: 4, answerSelectionEnd: 9,
    questionNote: 'Synthetic private question note', runningNote: 'Synthetic private running note',
  });
});

test('status radio keeps focus and node identity through autosave update', async ({ page }) => {
  await startFreshInterview(page);
  await page.locator('#answer').fill('Current state summary');
  const answered = page.locator('label.status-chip', { hasText: 'Answered' }).locator('input');
  await page.locator('label.status-chip', { hasText: 'Answered' }).click();
  await page.waitForTimeout(280);
  await expect(answered).toBeFocused();
  await expect(answered).toBeChecked();
  const nodeId = await answered.evaluate((element) => element.outerHTML);
  await page.waitForTimeout(280);
  await expect(answered).toBeFocused();
  expect(await answered.evaluate((element) => element.outerHTML)).toBe(nodeId);
});

test('status chips are re-derived from persisted semantic state after status and answer edits', async ({ page }) => {
  await startFreshInterview(page);
  const alreadyKnown = page.locator('label.status-chip', { hasText: 'Already known' }).locator('input');
  const answered = page.locator('label.status-chip', { hasText: 'Answered' }).locator('input');

  await page.locator('label.status-chip', { hasText: 'Already known' }).click();
  await expect(alreadyKnown).not.toBeChecked();
  await expect(page.locator('input[name="status"]:checked')).toHaveCount(0);

  await page.locator('#answer').fill('Client supplied current state');
  await expect(answered).toBeChecked();
  await expect(page.locator('label.status-chip', { hasText: 'Answered' })).toHaveClass(/selected/);
});

test('N/A coverage is visible in summaries and counts toward disposed mobile coverage', async ({ page }) => {
  await startFreshInterview(page);
  await page.locator('label.status-chip', { hasText: 'N/A' }).click();

  await expect(page.locator('[data-coverage-resolved]')).toContainText('0 current');
  await expect(page.locator('[data-coverage-resolved]')).toContainText('1 N/A');
  await expect(page.locator('[data-coverage-mobile]')).toHaveText('Coverage 1/5');

  await advanceToQuestion(page, 'What absolutely has to be true for the first version to feel successful?');
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('.review-stats')).toContainText('0 current');
  await expect(page.locator('.review-stats')).toContainText('1 N/A');
});

test('single-choice answer keeps focus when conditional visibility is unchanged', async ({ page }) => {
  await startFreshInterview(page);
  await advanceToQuestion(page, 'Do people need to request or book time?');
  const notSure = page.getByRole('radio', { name: 'Not sure' });
  await notSure.check();
  await page.waitForTimeout(280);
  await expect(notSure).toBeFocused();
  const yes = page.getByRole('radio', { name: 'Yes' });
  await yes.check();
  await page.waitForTimeout(280);
  await expect(yes).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Do people need to request or book time?', level: 1 })).toBeVisible();
});

test('single-choice answer rerenders when conditional visibility changes', async ({ page }) => {
  await startFreshInterview(page);
  await advanceToQuestion(page, 'Do people need to request or book time?');
  await page.getByRole('radio', { name: 'Yes' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await page.locator('[data-action="back"]').click();
  await page.locator('fieldset.choice-group input[value="No"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What absolutely has to be true for the first version to feel successful?', level: 1 })).toBeVisible();
});

test('semantic branching keeps pending visible, ignores deferred/N-A raw values, and reviews reactivated evidence', async ({ page }) => {
  await startFreshInterview(page, 'Semantic Branching Test');
  await advanceToQuestion(page, 'Do people need to request or book time?');

  // Unknown parent evidence is pending, so the dependent objective remains visible rather than collapsing to No.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await page.locator('#answer').fill('Retained booking detail');
  await page.locator('[data-action="back"]').click();

  // Authoritative No makes the child irrelevant.
  await page.locator('fieldset.choice-group input[value="No"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What absolutely has to be true for the first version to feel successful?', level: 1 })).toBeVisible();
  await page.locator('[data-action="back"]').click();

  // Reactivating Yes restores the retained value for human review, not silent completion.
  await page.locator('fieldset.choice-group input[value="Yes"]').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('#answer')).toHaveValue('Retained booking detail');
  await expect(page.locator('label.status-chip', { hasText: 'Must confirm' }).locator('input')).toBeChecked();
  await page.locator('[data-action="back"]').click();

  // A retained raw Yes under N/A is not effective evidence. Unknown/pending is not implicit No,
  // so the child remains visible but its coverage bucket must be open rather than confirmed.
  await page.locator('fieldset.choice-group input[value="Yes"]').check();
  await page.locator('label.status-chip', { hasText: 'N/A' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('[data-question-id="booking-process"]')).not.toHaveClass(/confirm/);
  await page.locator('[data-action="back"]').click();

  // Deferred behaves the same way: retained raw Yes remains pending/non-authoritative.
  await page.locator('label.status-chip', { hasText: 'Skip' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should booking or scheduling work?', level: 1 })).toBeVisible();
  await expect(page.locator('[data-question-id="booking-process"]')).not.toHaveClass(/confirm/);
});

test('Continue and Back land focus on the next or previous answer control', async ({ page }) => {
  await startFreshInterview(page);
  await page.locator('#answer').fill('Current state summary');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#answer')).toBeFocused({ timeout: 5000 });
  await page.locator('[data-action="back"]').click();
  await expect(page.locator('#answer')).toBeFocused({ timeout: 5000 });
});

test('320px phone coverage and context panels expose dialog semantics and isolate background', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startFreshInterview(page);
  await expect(page.locator('[data-save-indicator]')).toBeVisible();
  await expect(page.locator('[data-connectivity-indicator]').first()).toBeVisible();

  const coverageTrigger = page.locator('#coverage-mobile-trigger');
  const contextTrigger = page.locator('#context-mobile-trigger');
  await coverageTrigger.click();
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(contextTrigger).toHaveAttribute('aria-expanded', 'false');
  const coveragePanel = page.locator('#coverage-mobile-panel');
  await expect(coveragePanel).toHaveAttribute('role', 'dialog');
  await expect(page.locator('.question-stage')).toHaveJSProperty('inert', true);
  await expect(page.getByRole('button', { name: 'Close coverage' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(coverageTrigger).toBeFocused();

  await contextTrigger.click();
  await expect(contextTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(coverageTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#context-mobile-panel')).toHaveAttribute('role', 'dialog');
  await page.getByRole('button', { name: 'Close context' }).click();
  await expect(contextTrigger).toBeFocused();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test('review Change control keeps contextual accessible name', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-review-a11y');
  row.answers['existing-presence'] = { value: 'Baseline answer', resolution: 'captured', source: 'client-statement', needsConfirmation: false, confirmation: null, followUp: null, note: '' };
  row.currentQuestionId = 'must-have';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.getByRole('button', { name: 'Change What is already in place today?' })).toBeVisible();
});

test('mixed Home records support explicit upgrade and recovery backup', async ({ page }) => {
  await page.goto('/');
  const current = await syntheticSession('synthetic-current-mixed');
  const legacy = await syntheticPinned12Session({ sessionId: 'synthetic-legacy-mixed' });
  legacy.sessionSchemaVersion = '1.1.0';
  delete legacy.packSnapshot.ruleSemanticsVersion;
  legacy.packIdentity.digest = await sha256Hex(canonicalizeJson(legacy.packSnapshot));
  const unsupported = { sessionId: 'synthetic-future-mixed', sessionSchemaVersion: '9.0.0', futurePayload: { retained: true } };
  const malformed = structuredClone(current);
  malformed.sessionId = 'synthetic-malformed-mixed';
  malformed.packIdentity.digest = '0'.repeat(64);
  const unsafeMalformed = { sessionId: 'synthetic-unsafe-malformed-mixed', sessionSchemaVersion: null, unsafeValue: Number.NaN };
  for (const row of [current, legacy, unsupported, malformed, unsafeMalformed]) await putRawSession(page, row);
  const seededSnapshot = await readStorageSnapshot(page);
  await page.reload();
  await expect(page.getByRole('button', { name: /Synthetic Browser Test/ })).toBeVisible();
  await expect(page.getByText('Older interview format')).toBeVisible();
  await expect(page.getByText('Unsupported interview format')).toBeVisible();
  await expect(page.getByText('An interview record could not be read.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(1);
  await expect(page.locator('[data-recovery-id="synthetic-future-mixed"]')).toBeVisible();
  await expect(page.locator('[data-recovery-id="synthetic-malformed-mixed"]')).toBeVisible();
  await expect(page.locator('[data-recovery-id="synthetic-unsafe-malformed-mixed"]')).toHaveCount(0);
  await expect(page.locator('[data-session-id="synthetic-malformed-mixed"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upgrade' })).toHaveCount(1);
  await expect(page.getByText('5 local interviews could not be read.')).toHaveCount(0);
  const homeSnapshot = await readStorageSnapshot(page);
  expect(homeSnapshot).toEqual(seededSnapshot);
  expect(homeSnapshot.rows).toHaveLength(5);
  expect(homeSnapshot.archives).toHaveLength(0);
  expect(homeSnapshot.archiveKeys).toHaveLength(0);
  const currentBefore = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ldw-interview-facilitator', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const value = await new Promise<unknown>((resolve, reject) => { const request = db.transaction('sessions').objectStore('sessions').get(sessionId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return value;
  }, legacy.sessionId);
  expect(currentBefore).toMatchObject({ sessionSchemaVersion: '1.1.0' });
  const upgradedCard = page.locator('[data-session-id="synthetic-legacy-mixed"]');
  await page.getByRole('button', { name: 'Upgrade' }).click();
  await expect(page.getByText('Older interview format')).toHaveCount(0);
  await expect(upgradedCard).toBeVisible();
  const upgraded = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('ldw-interview-facilitator', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction(['sessions', 'legacy-session-archive']);
    const read = (storeName: string, key: IDBValidKey) => new Promise<unknown>((resolve, reject) => { const request = transaction.objectStore(storeName).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const values = {
      active: await read('sessions', sessionId),
      archive11: await read('legacy-session-archive', `${sessionId}|1.1.0|pinned-1.1-to-1.2`),
      archive12: await read('legacy-session-archive', `${sessionId}|1.2.0|pinned-1.2-to-1.3`),
    };
    db.close(); return values;
  }, legacy.sessionId);
  expect(upgraded.active).toMatchObject({ sessionSchemaVersion: '1.3.0', packSnapshot: { ruleSemanticsVersion: 'effective-evidence-equals-v2' } });
  expect(upgraded.archive11).toEqual(legacy);
  expect(upgraded.archive12).toMatchObject({
    sessionSchemaVersion: '1.2.0',
    parentRevisionId: (currentBefore as InterviewSession).revisionId,
    packSnapshot: { ruleSemanticsVersion: 'condition-equals-v1' },
  });
  expect((upgraded.active as SemanticInterviewSession).parentRevisionId).toBe((upgraded.archive12 as InterviewSession).revisionId);
  expect(await validateSemanticSessionRecord(upgraded.active)).toEqual(upgraded.active);
  const download = page.waitForEvent('download');
  await page.locator('[data-recovery-id="synthetic-future-mixed"]').click();
  const recoveryDownload = await download;
  expect(recoveryDownload.suggestedFilename()).toBe('interview-facilitator-recovery-backup.json');
  const recoveryStream = await recoveryDownload.createReadStream();
  if (!recoveryStream) throw new Error('Recovery download stream was unavailable.');
  recoveryStream.setEncoding('utf8');
  let recoveryJson = '';
  for await (const chunk of recoveryStream) recoveryJson += chunk;
  const recoveryBackup = JSON.parse(recoveryJson) as { backupType: string; formatVersion: string; record: unknown };
  expect(recoveryBackup).toMatchObject({ backupType: 'interview-facilitator-recovery-internal', formatVersion: '1' });
  expect(recoveryBackup.record).toEqual(unsupported);

  const malformedDownload = page.waitForEvent('download');
  await page.locator('[data-recovery-id="synthetic-malformed-mixed"]').click();
  const quarantinedDownload = await malformedDownload;
  const quarantinedStream = await quarantinedDownload.createReadStream();
  if (!quarantinedStream) throw new Error('Quarantined recovery stream was unavailable.');
  quarantinedStream.setEncoding('utf8');
  let quarantinedJson = '';
  for await (const chunk of quarantinedStream) quarantinedJson += chunk;
  const quarantinedBackup = JSON.parse(quarantinedJson) as { record: unknown };
  expect(quarantinedBackup.record).toEqual(malformed);

  const snapshot = await readStorageSnapshot(page);
  expect(snapshot.rows).toHaveLength(5);
  expect(snapshot.archives).toHaveLength(2);
  expect(snapshot.archiveKeys).toEqual([
    'synthetic-legacy-mixed|1.1.0|pinned-1.1-to-1.2',
    'synthetic-legacy-mixed|1.2.0|pinned-1.2-to-1.3',
  ]);
  expect(snapshot.rows).toContainEqual(current);
  expect(snapshot.rows).toContainEqual(unsupported);
  expect(snapshot.rows).toContainEqual(malformed);
  expect(snapshot.rows).toContainEqual(unsafeMalformed);
  expect(snapshot.rows).toContainEqual(upgraded.active);
  expect(snapshot.archives).toContainEqual(legacy);
  expect(snapshot.archives).toContainEqual(upgraded.archive12);

  const healthyCurrentCard = page.locator('[data-session-id="synthetic-current-mixed"]');
  await expect(healthyCurrentCard).toBeVisible();
  await healthyCurrentCard.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?' })).toBeVisible();
  await page.goto('/');
  await expect(upgradedCard).toBeVisible();
  await upgradedCard.click();
  await expect(page.getByRole('heading', { name: 'What is already in place today?' })).toBeVisible();
});

test('failed legacy upgrade aborts its transaction and preserves source and archive', async ({ page }) => {
  await page.goto('/');
  const legacy = await syntheticPinned12Session({ sessionId: 'synthetic-legacy-abort' });
  legacy.sessionSchemaVersion = '1.1.0';
  delete legacy.packSnapshot.ruleSemanticsVersion;
  legacy.packIdentity.digest = await sha256Hex(canonicalizeJson(legacy.packSnapshot));
  await putRawSession(page, legacy);
  await page.reload();
  await expect(page.getByText('Older interview format')).toBeVisible();

  await page.evaluate((sessionId) => {
    const state = window as Window & { __legacyMigrationAbortObserved?: boolean };
    state.__legacyMigrationAbortObserved = false;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const [value] = args;
      if (this.name === 'sessions' && value && typeof value === 'object' && (value as { sessionId?: string }).sessionId === sessionId) {
        throw new DOMException('Synthetic legacy-upgrade put failure.', 'DataError');
      }
      return originalPut.apply(this, args);
    };
    const originalAbort = IDBTransaction.prototype.abort;
    IDBTransaction.prototype.abort = function () {
      this.addEventListener('abort', () => { state.__legacyMigrationAbortObserved = true; }, { once: true });
      return originalAbort.call(this);
    };
  }, legacy.sessionId);

  await page.getByRole('button', { name: 'Upgrade' }).click();
  await expect(page.getByText(/^Upgrade did not complete\..*The original interview and any prior recovery record were preserved\.$/)).toBeVisible();
  await expect(page.getByText('Older interview format')).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __legacyMigrationAbortObserved?: boolean }).__legacyMigrationAbortObserved)).toBe(true);

  const snapshot = await readStorageSnapshot(page);
  expect(snapshot.rows).toEqual([legacy]);
  expect(snapshot.archives).toEqual([]);
  expect(snapshot.archiveKeys).toEqual([]);
});


async function setSyntheticPrepInput(page: Page, json: string): Promise<void> {
  // Populate an actual in-browser File without requiring Node's Buffer types.
  await page.evaluate((data) => {
    const input = document.querySelector<HTMLInputElement>('#synthetic-prep-file');
    if (!input) throw new Error('Synthetic preparation picker missing');
    const files = new DataTransfer();
    files.items.add(new File([data], 'synthetic-prep.json', { type: 'application/json' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, json);
}

test('private synthetic prep file is reviewed offline without altering saved answers or Presentation', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-local-prep-ui');
  row.currentQuestionId = 'must-have';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  // Next-to-Review defaults to protected Presentation; leave it explicitly.
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('#synthetic-prep-file')).toBeVisible();
  // The trial now flushes normal autosave before pinning the packet; wait for
  // its stable stored revision, rather than using the obsolete fixture SHA.
  await expect(page.locator('[data-save-indicator]')).toContainText(/^Saved/);
  const before = await readStorageSnapshot(page);
  const review = page.getByRole('region', { name: 'Synthetic preparation candidate review' });
  const syntheticValue = 'SYNTHETIC <img src=x onerror=alert(1)> REVIEW FACT';
  const packet = {
    schemaVersion: 'ldw.interview-prep.v1',
    jobKey: 'SYNTHETIC-PREP-LOCAL-01',
    sessionId: row.sessionId,
    expectedRevisionId: (before.rows[0] as SemanticInterviewSession).revisionId,
    expectedPackDigest: row.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [{
      candidateId: 'candidate-a', questionId: 'existing-presence',
      proposedValue: syntheticValue, sourceSystem: 'manual',
      sourceRecordRef: 'SYNTHETIC-REF-LOCAL-01',
      observedAt: '2026-11-09T14:00:00.000Z', confidence: 'unverified',
    }],
  };
  await setSyntheticPrepInput(page, JSON.stringify(packet));
  await expect(review.getByRole('heading', { name: 'Private preparation — candidate review trial' }))
    .toBeVisible();
  await expect(review).toContainText(syntheticValue);
  // Untrusted source markup remains literal text, not an executable element.
  expect(await review.locator('img[src="x"]').count()).toBe(0);
  await expect(review.getByRole('button', { name: /Prepare selected candidate proposal/ })).toBeDisabled();
  await review.getByRole('radio').check();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: /Prepare selected candidate proposal/ }).click();
  await expect(review).toContainText('Private candidate proposal assembled in local memory');
  expect(await readStorageSnapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Open presentation view' }).click();
  await expect(page.getByText(syntheticValue)).toHaveCount(0);
  await expect(page.locator('#synthetic-prep-file')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.getByRole('region', { name: 'Synthetic preparation candidate review' }))
    .toContainText('No synthetic preparation packet loaded');
  // Normal interview navigation can save its current empty control and rotate
  // the session revision. That is NOT a write by the prep trial. Prove that no
  // private candidate or provenance crossed into any local canonical record.
  const afterPresentation = await readStorageSnapshot(page);
  expect(JSON.stringify(afterPresentation)).not.toContain(syntheticValue);
  expect(JSON.stringify(afterPresentation)).not.toContain(packet.candidates[0]!.sourceRecordRef);
  expect((afterPresentation.rows as SemanticInterviewSession[])[0]!.answers['existing-presence']!.value)
    .toBeNull();
});

test('synthetic prep UI rejects wrong revision and disappears entirely for normal client sessions', async ({ page }) => {
  await page.goto('/');
  const row = await syntheticSession('synthetic-local-prep-negative');
  row.currentQuestionId = 'must-have';
  await putRawSession(page, row);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  // Next-to-Review defaults to protected Presentation; leave it explicitly.
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('#synthetic-prep-file')).toBeVisible();
  // The trial now flushes normal autosave before pinning the packet; wait for
  // its stable stored revision, rather than using the obsolete fixture SHA.
  await expect(page.locator('[data-save-indicator]')).toContainText(/^Saved/);
  const before = await readStorageSnapshot(page);
  await setSyntheticPrepInput(page, JSON.stringify({
    schemaVersion: 'ldw.interview-prep.v1',
    jobKey: 'SYNTHETIC-WRONG-REVISION',
    sessionId: row.sessionId,
    expectedRevisionId: 'stale-revision',
    expectedPackDigest: row.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [],
  }));
  await expect(page.getByRole('region', { name: 'Synthetic preparation candidate review' }))
    .toContainText('packet was rejected or became stale');
  expect(await readStorageSnapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Discard preparation review' }).click();
  await expect(page.getByRole('region', { name: 'Synthetic preparation candidate review' }))
    .toContainText('No synthetic preparation packet loaded');

  await page.getByRole('button', { name: 'Home' }).click();
  const ordinary = await syntheticSession('trial-hidden-for-real-client');
  ordinary.clientLabel = 'Normal Business — demo data only';
  ordinary.currentQuestionId = 'must-have';
  await putRawSession(page, ordinary);
  await page.reload();
  await page.getByRole('button', { name: /Normal Business/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await expect(page.locator('#synthetic-prep-file')).toHaveCount(0);
  await expect(page.getByText('Synthetic preparation — private review trial')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check retained local revision continuity' })).toHaveCount(0);
});


test('synthetic private selection needs separate human client statement and saves one atomic revision with old history', async ({ page }) => {
  await page.goto('/');
  const seeded = await syntheticSession('synthetic-confirmation-success');
  seeded.currentQuestionId = 'must-have';
  await putRawSession(page, seeded);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  // The normal Review navigation can schedule a 180ms local autosave.
  // Pin the synthetic packet to a completed, not transient, revision.
  await expect(page.locator('[data-save-indicator]')).toContainText(/^Saved/);
  await expect(page.locator('#synthetic-prep-file')).toBeVisible();
  const savedBefore = (await readStorageSnapshot(page)).rows[0] as SemanticInterviewSession;
  const packet = {
    schemaVersion: 'ldw.interview-prep.v1',
    jobKey: 'SYNTHETIC-HUMAN-CONFIRM-01',
    sessionId: savedBefore.sessionId,
    expectedRevisionId: savedBefore.revisionId,
    expectedPackDigest: savedBefore.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [{
      candidateId: 'source-01', questionId: 'primary-goal',
      proposedValue: 'SYNTHETIC SOURCE SUGGESTION NOT THE CLIENT ANSWER',
      sourceSystem: 'manual',
      sourceRecordRef: 'SYNTHETIC-RESEARCH-PRIVATE-REF',
      observedAt: '2026-11-09T14:00:00.000Z',
      confidence: 'unverified',
    }],
  };
  await setSyntheticPrepInput(page, JSON.stringify(packet));
  const candidate = page.getByRole('region', { name: 'Synthetic preparation candidate review' });
  await expect(candidate).toContainText(packet.candidates[0]!.proposedValue);
  await candidate.getByRole('radio').check();
  await candidate.getByRole('checkbox').check();
  await candidate.getByRole('button', { name: /Prepare selected candidate proposal/ }).click();
  const confirmedPanel = page.getByRole('region', { name: 'Synthetic client confirmation trial' });
  await expect(confirmedPanel.getByRole('heading', { name: /Record a separate client-confirmed statement/ }))
    .toBeVisible();
  const evidence = confirmedPanel.getByRole('region', { name: 'Unconfirmed research context — private only' });
  await expect(evidence).toContainText('Research proposed: ' + packet.candidates[0]!.proposedValue);
  await expect(evidence).toContainText('Claimed source: manual');
  await expect(evidence).toContainText('confidence: unverified');
  await expect(evidence).toContainText('not the client statement or accepted evidence');
  // The source suggestion must remain read-only and NEVER prefill the separate
  // client-statement editor, enter the canonical answer, or become consent.
  await expect(confirmedPanel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' }))
    .toBeEmpty();
  await expect(evidence.locator('input, textarea, select')).toHaveCount(0);
  const save = confirmedPanel.getByRole('button', { name: 'Save synthetic client-confirmed answer locally' });
  await expect(save).toBeDisabled();
  await confirmedPanel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' })
    .fill('SYNTHETIC CLIENT INDEPENDENTLY CONFIRMED AN EXISTING WEBSITE');
  await expect(save).toBeDisabled();
  await confirmedPanel.getByRole('checkbox').check();
  await expect(save).toBeEnabled();
  const beforeCommit = await readStorageSnapshot(page);
  expect(beforeCommit.rows).toEqual([savedBefore]);
  await save.click();
  await expect(page.locator('[data-synthetic-confirmation-saved]'))
    .toContainText('Synthetic client statement saved locally');
  const after = (await readStorageSnapshot(page)).rows[0] as SemanticInterviewSession;
  expect(after.answers['primary-goal']).toMatchObject({
    value: 'SYNTHETIC CLIENT INDEPENDENTLY CONFIRMED AN EXISTING WEBSITE',
    resolution: 'captured', source: 'client-statement', confirmation: null,
  });
  expect(after.parentRevisionId).toBe(savedBefore.revisionId);
  expect(after.revisionId).not.toBe(savedBefore.revisionId);
  expect(after.sessionId).toBe(savedBefore.sessionId);
  expect(JSON.stringify(after)).not.toContain(packet.candidates[0]!.sourceRecordRef);
  expect(JSON.stringify(after)).not.toContain(packet.candidates[0]!.proposedValue);
  expect(after.answers['primary-goal']!.value).not.toEqual(packet.candidates[0]!.proposedValue);

  const history = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('revision-history', 'readonly')
        .objectStore('revision-history').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return records;
  });
  expect(history).toHaveLength(1);
  expect(history[0]).toEqual(savedBefore);
  // This is a READ-ONLY inventory: one retained parent chain, not an
  // off-device or encrypted history archive.
  const beforeAudit = await readStorageSnapshot(page);
  await page.getByRole('button', { name: 'Check retained local revision continuity' }).click();
  const audit = page.getByRole('region', { name: 'Local revision continuity result' });
  await expect(audit).toContainText('1 local archived revision(s); 1 linked to current, 0 unlinked');
  // The explicit confirmation archived its immediate parent, but ordinary
  // preceding autosave revisions are NOT all retained. This must report
  // a real gap rather than a falsely complete recovery chain.
  await expect(audit).toContainText('missing at least one prior revision');
  expect(await readStorageSnapshot(page)).toEqual(beforeAudit);
  await page.getByRole('button', { name: 'Open presentation view' }).click();
  await expect(page.getByRole('region', { name: 'Local revision continuity result' })).toHaveCount(0);
  await expect(page.locator('#synthetic-prep-file')).toHaveCount(0);
  await expect(page.getByText(packet.candidates[0]!.proposedValue)).toHaveCount(0);
  await expect(page.getByText(packet.candidates[0]!.sourceRecordRef)).toHaveCount(0);
  await expect(page.getByText('SYNTHETIC CLIENT INDEPENDENTLY CONFIRMED AN EXISTING WEBSITE')).toBeVisible();
});

test('synthetic confirmation refuses an unseen same-revision storage edit without writing a client answer', async ({ page }) => {
  await page.goto('/');
  const seeded = await syntheticSession('synthetic-confirmation-stale');
  seeded.currentQuestionId = 'must-have';
  await putRawSession(page, seeded);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  // The normal Review navigation can schedule a 180ms local autosave.
  // Pin the synthetic packet to a completed, not transient, revision.
  await expect(page.locator('[data-save-indicator]')).toContainText(/^Saved/);
  const saved = (await readStorageSnapshot(page)).rows[0] as SemanticInterviewSession;
  const packet = {
    schemaVersion: 'ldw.interview-prep.v1',
    jobKey: 'SYNTHETIC-HUMAN-CONFIRM-STALE',
    sessionId: saved.sessionId, expectedRevisionId: saved.revisionId,
    expectedPackDigest: saved.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [{
      candidateId: 'a', questionId: 'primary-goal',
      proposedValue: 'SYNTHETIC RESEARCH VALUE NOT ACCEPTED',
      sourceSystem: 'manual', sourceRecordRef: 'SYNTHETIC-REF-STALE',
      observedAt: '2026-11-09T14:00:00.000Z', confidence: 'unverified',
    }],
  };
  await setSyntheticPrepInput(page, JSON.stringify(packet));
  const candidate = page.getByRole('region', { name: 'Synthetic preparation candidate review' });
  await expect(candidate.getByRole('radio')).toBeVisible();
  await candidate.getByRole('radio').check();
  await candidate.getByRole('checkbox').check();
  await candidate.getByRole('button', { name: /Prepare selected candidate proposal/ }).click();
  const panel = page.getByRole('region', { name: 'Synthetic client confirmation trial' });
  await expect(panel.getByRole('heading', { name: /Record a separate client-confirmed statement/ })).toBeVisible();

  // Simulate another writer changing the stored canonical JSON without
  // advancing the revision. A revision-only CAS would accept this; full CAS
  // must refuse and preserve the other writer's content.
  await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const request = store.get(sessionId);
      request.onsuccess = () => {
        const value = request.result as SemanticInterviewSession;
        value.runningNotes = 'SYNTHETIC CONCURRENT LOCAL EDIT';
        store.put(value);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, saved.sessionId);

  await panel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' })
    .fill('SYNTHETIC NEW CLIENT STATEMENT CANNOT OVERWRITE');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save synthetic client-confirmed answer locally' }).click();
  await expect(panel).toContainText('The local interview changed. No confirmation was saved.');
  // A rejected full-CAS attempt must unlock the form, but never silently
  // reuse the old acknowledgment or claim that its contents were saved.
  await expect(panel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' })).toBeEnabled();
  await expect(panel.getByRole('combobox', { name: 'Question for explicit client confirmation' })).toBeEnabled();
  await expect(panel.getByRole('checkbox')).toBeEnabled();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save synthetic client-confirmed answer locally' })).toBeDisabled();
  const after = (await readStorageSnapshot(page)).rows[0] as SemanticInterviewSession;
  expect(after.runningNotes).toBe('SYNTHETIC CONCURRENT LOCAL EDIT');
  expect(after.revisionId).toBe(saved.revisionId);
  expect(after.answers['primary-goal']!.value).toBeNull();
  expect(JSON.stringify(after)).not.toContain(packet.candidates[0]!.sourceRecordRef);
  const count = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('revision-history', 'readonly')
        .objectStore('revision-history').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  });
  expect(count).toBe(0);
});


test('synthetic confirmation refuses unsupported strict durability before writing either IndexedDB store', async ({ page }) => {
  await page.goto('/');
  const seeded = await syntheticSession('synthetic-strict-durability-gate');
  seeded.currentQuestionId = 'must-have';
  await putRawSession(page, seeded);
  await page.reload();
  await page.getByRole('button', { name: /Synthetic Browser Test/ }).click();
  await page.getByRole('button', { name: 'Review interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('[data-save-indicator]')).toContainText(/^Saved/);
  const before = (await readStorageSnapshot(page)).rows[0] as SemanticInterviewSession;
  const packet = {
    schemaVersion: 'ldw.interview-prep.v1',
    jobKey: 'SYNTHETIC-STRICT-DURABILITY-01',
    sessionId: before.sessionId, expectedRevisionId: before.revisionId,
    expectedPackDigest: before.packIdentity.digest,
    preparedAt: '2026-11-09T14:30:00.000Z',
    candidates: [{
      candidateId: 'candidate-a', questionId: 'primary-goal',
      proposedValue: 'SYNTHETIC RESEARCH WILL NOT BE ACCEPTED',
      sourceSystem: 'manual', sourceRecordRef: 'SYNTHETIC-STRICT-REF',
      observedAt: '2026-11-09T14:00:00.000Z', confidence: 'unverified',
    }],
  };
  await setSyntheticPrepInput(page, JSON.stringify(packet));
  const candidate = page.getByRole('region', { name: 'Synthetic preparation candidate review' });
  await expect(candidate.getByRole('radio')).toBeVisible();
  await candidate.getByRole('radio').check();
  await candidate.getByRole('checkbox').check();
  await candidate.getByRole('button', { name: /Prepare selected candidate proposal/ }).click();
  const panel = page.getByRole('region', { name: 'Synthetic client confirmation trial' });
  await expect(panel.getByRole('heading', { name: /Record a separate client-confirmed statement/ })).toBeVisible();

  // Emulate an engine rejecting the strict transaction option. The synthetic
  // confirmation must NOT downgrade to a normal readwrite transaction.
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions,
    ): IDBTransaction {
      if (Array.isArray(stores) && stores.includes('revision-history')
        && mode === 'readwrite' && options?.durability === 'strict') {
        throw new DOMException('Strict transaction unsupported', 'NotSupportedError');
      }
      return original.call(this, stores, mode, options);
    };
  });
  await panel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' })
    .fill('SYNTHETIC CLIENT CONFIRMED, BUT STRICT STORAGE IS UNAVAILABLE');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save synthetic client-confirmed answer locally' }).click();
  await expect(panel).toContainText('Could not verify the synthetic confirmation save.');
  await expect(panel.getByRole('textbox', { name: 'What the synthetic client actually confirmed' })).toBeEnabled();
  await expect(panel.getByRole('combobox', { name: 'Question for explicit client confirmation' })).toBeEnabled();
  await expect(panel.getByRole('checkbox')).toBeEnabled();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save synthetic client-confirmed answer locally' })).toBeDisabled();
  expect((await readStorageSnapshot(page)).rows).toEqual([before]);
  const historyCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ldw-interview-facilitator', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('revision-history', 'readonly')
        .objectStore('revision-history').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
  expect(historyCount).toBe(0);
  await expect(page.locator('[data-synthetic-confirmation-saved]')).toHaveCount(0);
});

async function startSyntheticInterview(page: import('@playwright/test').Page, label = 'Synthetic Focus Mode'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill(label);
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.locator('.action-dock')).toBeVisible();
}

test('Question focus mode (1440): toggle hides rails inert without re-rendering the answer control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startSyntheticInterview(page);
  const answer = page.locator('#answer');
  await answer.fill('Synthetic partial answer for focus toggle');
  await page.evaluate(() => {
    document.querySelector('#answer')?.setAttribute('data-focus-ref', 'keep');
  });
  await page.getByRole('button', { name: 'Focus on question' }).click();
  await expect(page.getByRole('button', { name: 'Show full workspace' })).toHaveAttribute('aria-pressed', 'true');
  const afterToggle = await page.evaluate(() => {
    const coverage = document.querySelector('.coverage-rail') as HTMLElement | null;
    const context = document.querySelector('.context-rail') as HTMLElement | null;
    const el = document.querySelector('#answer') as HTMLTextAreaElement | null;
    return {
      sameNode: el?.getAttribute('data-focus-ref') === 'keep',
      value: el?.value ?? '',
      coverageInert: coverage?.inert === true,
      contextInert: context?.inert === true,
      focusModeClass: document.querySelector('#app')?.classList.contains('question-focus-mode') === true,
    };
  });
  expect(afterToggle.sameNode).toBe(true);
  expect(afterToggle.value).toBe('Synthetic partial answer for focus toggle');
  expect(afterToggle.coverageInert).toBe(true);
  expect(afterToggle.contextInert).toBe(true);
  expect(afterToggle.focusModeClass).toBe(true);
  await page.getByRole('button', { name: 'Show full workspace' }).click();
  const restored = await page.evaluate(() => {
    const coverage = document.querySelector('.coverage-rail') as HTMLElement | null;
    const context = document.querySelector('.context-rail') as HTMLElement | null;
    return {
      coverageInert: coverage?.inert === true,
      contextInert: context?.inert === true,
      focusModeClass: document.querySelector('#app')?.classList.contains('question-focus-mode') === true,
    };
  });
  expect(restored.coverageInert).toBe(false);
  expect(restored.contextInert).toBe(false);
  expect(restored.focusModeClass).toBe(false);
});

test('Question focus mode (1024): autosave continues after toggle and next question', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await startSyntheticInterview(page);
  await page.getByRole('button', { name: 'Focus on question' }).click();
  const answerField = page.locator('#answer, textarea#answer, input#answer').first();
  await answerField.fill('Synthetic autosave after focus');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('What is already in place today?');
  await expect(page.getByRole('button', { name: 'Show full workspace' })).toBeVisible();
  await expect(page.locator('[data-save-indicator]').first()).toContainText(/saved|protected/i);
  const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  const stored = rows.find((item) => item.clientLabel === 'Synthetic Focus Mode');
  expect(stored?.answers['existing-presence']?.value).toBe('Synthetic autosave after focus');
});

test('Question focus mode (320): mobile layout unchanged and toggle absent', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await startSyntheticInterview(page);
  await expect(page.getByRole('button', { name: 'Focus on question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Coverage' })).toBeVisible();
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test('Question focus mode: Presentation view excludes the toggle and resets focus chrome', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startSyntheticInterview(page);
  await page.getByRole('button', { name: 'Focus on question' }).click();
  await page.getByRole('button', { name: 'Presentation view' }).click();
  await expect(page.getByRole('button', { name: 'Focus on question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show full workspace' })).toHaveCount(0);
  const state = await page.evaluate(() => document.querySelector('#app')?.classList.contains('question-focus-mode'));
  expect(state).toBe(false);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.getByRole('button', { name: 'Focus on question' })).toBeVisible();
});

async function openSyntheticReviewFromInterview(page: import('@playwright/test').Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      await expect(page.getByRole('heading', { name: /Read back what matters/ })).toBeVisible();
      return;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  throw new Error('Review interview control did not appear.');
}

test('Question focus mode: review return resets focus chrome', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startSyntheticInterview(page, 'Synthetic Focus Session A');
  await page.getByRole('button', { name: 'Focus on question' }).click();
  await openSyntheticReviewFromInterview(page);
  await page.getByRole('button', { name: '← Return to interview' }).click();
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.getByRole('button', { name: 'Focus on question' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.querySelector('#app')?.classList.contains('question-focus-mode'))).toBe(false);
});

test('Question focus mode: reopening a stored session clears focus chrome', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startSyntheticInterview(page, 'Synthetic Focus Reopen');
  await page.getByRole('button', { name: 'Focus on question' }).click();
  await openSyntheticReviewFromInterview(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Synthetic Focus Reopen' }).click();
  await expect(page.getByRole('button', { name: 'Focus on question' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.querySelector('#app')?.classList.contains('question-focus-mode'))).toBe(false);
});

async function openSyntheticReviewFromInterviewForLens(page: import('@playwright/test').Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    const review = page.getByRole('button', { name: 'Review interview' });
    if (await review.isVisible()) {
      await review.click();
      await expect(page.getByRole('heading', { name: /Read back what matters/ })).toBeVisible();
      return;
    }
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  throw new Error('Review interview control did not appear.');
}

test('Private evidence lens: private review shows provenance at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Evidence Lens');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Synthetic captured answer');
  const before = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  await openSyntheticReviewFromInterviewForLens(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.getByText('not independently verified')).toBeVisible();
  await expect(page.locator('[data-evidence-lens]').first()).toBeVisible();
  const after = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
  expect(after).toEqual(before);
});

test('Private evidence lens: presentation hides evidence badges at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Evidence Privacy');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Private only detail');
  await openSyntheticReviewFromInterviewForLens(page);
  await expect(page.locator('[data-evidence-lens]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('[data-evidence-lens]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Presentation view', exact: true }).click();
  await expect(page.locator('[data-evidence-lens]')).toHaveCount(0);
  await expect(page.getByText('not independently verified')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('[data-evidence-lens]').first()).toBeVisible();
});

test('Private evidence lens: hostile answer text does not appear in badge markup', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Evidence Hostile');
  await page.getByRole('button', { name: 'Start interview' }).click();
  const hostile = '<svg onload=HOSTILE_EVIDENCE_LENS>';
  await page.locator('#answer').fill(hostile);
  await openSyntheticReviewFromInterviewForLens(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const lensHtml = await page.locator('[data-evidence-lens]').first().innerHTML();
  expect(lensHtml).not.toContain('HOSTILE_EVIDENCE_LENS');
  expect(lensHtml).not.toContain('<svg');
});

test('Private outcome glance: presentation DOM has zero glance nodes at 390', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Outcome Glance Privacy');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Captured synthetic outcome');
  await openSyntheticReviewFromInterviewForLens(page);
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Presentation view', exact: true }).click();
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(0);
  await expect(page.getByText('Private interviewer glance only')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  await expect(page.locator('[data-private-outcome-glance]')).toHaveCount(1);
});

test('Private outcome glance: hostile captured value is escaped in private review at 320', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Outcome Glance Hostile');
  await page.getByRole('button', { name: 'Start interview' }).click();
  // The first general question is not included in the outcome layout. Move to
  // the mapped primary-goal item so this test cannot pass by redacting the value.
  await page.locator('#answer').fill('Synthetic prior context');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'What outcome matters most from this work?' })).toBeVisible();
  const hostile = '<img src=x onerror=HOSTILE_OUTCOME_GLANCE>';
  await page.locator('#answer').fill(hostile);
  await openSyntheticReviewFromInterviewForLens(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const glance = page.locator('[data-private-outcome-glance]');
  await glance.locator('summary').click();
  const glanceHtml = await glance.innerHTML();
  // A safely escaped *visible* answer keeps its text marker but cannot create
  // an HTML element or fire its event handler.
  await expect(glance.getByText(hostile, { exact: true })).toBeVisible();
  expect(glanceHtml).toContain('&lt;img');
  expect(glanceHtml).toContain('HOSTILE_OUTCOME_GLANCE');
  expect(glanceHtml).not.toContain('<img');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('Private outcome glance: disclosure toggle does not mutate stored session row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Outcome Glance Storage');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Stable revision snapshot');
  await openSyntheticReviewFromInterviewForLens(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  // Wait for a persisted saved revision, not an arbitrary timeout or the
  // transitional in-flight review autosave. Then compare both stores.
  await expect(page.locator('[data-save-indicator]')).toContainText('Saved');
  await expect.poll(async () => {
    const rows = (await readStorageSnapshot(page)).rows as SemanticInterviewSession[];
    return rows.some((row) => row.answers['existing-presence']?.value === 'Stable revision snapshot');
  }).toBe(true);
  const before = await readStorageSnapshot(page);
  const glance = page.locator('[data-private-outcome-glance]');
  await glance.locator('summary').click();
  await glance.locator('summary').click();
  const after = await readStorageSnapshot(page);
  expect(after).toEqual(before);
});

test('Private outcome glance: early session shows notice and unresolved items at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New interview' }).click();
  await page.getByLabel('Project or client label').fill('Synthetic Outcome Glance Provenance');
  await page.getByRole('button', { name: 'Start interview' }).click();
  await page.locator('#answer').fill('Synthetic priority statement');
  await openSyntheticReviewFromInterviewForLens(page);
  await page.getByRole('button', { name: 'Exit presentation' }).click();
  const glance = page.locator('[data-private-outcome-glance]');
  await glance.locator('summary').click();
  await expect(glance.getByText('Private interviewer glance only')).toBeVisible();
  await expect(glance.locator('.private-outcome-glance-value', { hasText: 'Not established' }).first()).toBeVisible();
  await expect(glance.getByText('human judgment only')).toBeVisible();
});
