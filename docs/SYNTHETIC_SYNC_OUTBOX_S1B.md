# S1B — Dormant native IndexedDB offline-sync outbox trial

**Status:** Synthetic source-only browser proof, not product runtime or customer synchronization. Authority: [architecture #4](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4#issuecomment-6872727322), [roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5#issuecomment-6872731773), parent [business-operations#753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753). S1 pure revision planner [PR #141](https://github.com/LowcountryDigitalWorks/interview-facilitator/pull/141) was independently reviewed and accepted on main.

## Why this proof exists

Before connecting an interview app on mobile and desktop to any private service, we need evidence that each device can commit a **complete canonical session revision** and the corresponding **outbox record** in one native IndexedDB transaction. Losing an unsynchronized record while a local answer appears saved is unacceptable. A remote receipt must be validated before a pending item is removed, and competing tabs must not silently overwrite one another. This proof exercises native Chromium IndexedDB **only** on the existing Vite dev-only dormant browser harness, not the live 1.3 app.

## Strict isolation

- Source module `src/synthetic-sync-outbox-idb-trial.ts` is not imported by the PWA entry. Its dedicated `ldw-if-synthetic-offline-outbox-s1b-test` IndexedDB database is separate from live `ldw-interview-facilitator` and contains only fictional synthetic test records. It is intentionally **not** a client datastore, deployable production queue, sync endpoint, or hosted proof. The test cleans up its database.
- Four local transactional stores: `current` (stable per-session head), `history` (immutable complete validated revision snapshot per deterministic operation ID), `pending` (metadata-only queue), and `receipts` (synthetic receipt test records). Staging uses one native `readwrite` transaction over all stores; a failed request aborts all of them. Two tabs share one origin/test database and are CAS-guarded by expected revision and parent.
- Queue cap 32 pending operations in this **trial only**. On full capacity or stale writer, no current state, history, or pending entry can be partially changed. Historical full snapshots are retained after mocked acknowledgement. Replaying the same revision is a strict no-op; it never duplicates a queue item, even after a mocked ACK.
- `simulateVerifiedSyntheticAckForTrial` uses a **test-only caller marker**. It demonstrates exact matching of `operationId`, `sessionId`, revision, digest, `committed=true`, and *atomic* pending-deletion/receipt recording after the S1 pure evaluator verifies the offer. The marker is **NOT authenticated proof** of server durability and **NEVER** drives `SYNCED` in the PWA. Negative/forged/absent markers retain pending items.
- Complete session snapshots contain **sensitive data in a real deployment**. The synthetic trial intentionally stores fictional text only; copying this storage design directly to a customer deployment without private authorization, encryption/recovery/data classification, tenant access and retention review is forbidden.

## Browser tests and limits

The `synthetic-sync-outbox-native-idb-s1b.pw.ts` test is included only in the existing `playwright.readback.config.ts` dormant Chromium suite. It proves:
1. Native transactional commit of fictional 1.3 session + full history + pending, reload/close/reopen persistence, no client notes inside queue metadata, exact mock ACK, failed ACK retained, no duplicate replay, no live session DB creation.
2. Two actual browser tabs racing from one revision: one writes and the other returns `stale-no-write`; no lost overwrite.
3. Genuine native **asynchronous** IndexedDB `ConstraintError` inside pending-store `add` that aborts a transaction after current/history requests were queued; all stores roll back; safe retry then succeeds.
4. Queue limit 32: attempt 33 yields `queue-full-no-write` and unchanged current/history/pending.

**Not certified:** power-cut/fsync durability, low storage quota/eviction, Safari/WebKit/VoiceOver/installed PWA, protected context storage origin migration, real timers, background sync, server CAS, actual authenticated transport, encrypted backup, client data confidentiality, or per-tenant authorization. A browser test cannot prove future recovery under hardware failure. No service, account, authentication, provider, new dependency, web app UI, or native installer is activated.

## Next gated work

After full hosted exact-head CI, independent author-excluded H0/M0 review, guarded merge and exact merged-main PUSH CI, prepare an **approved private synthetic two-device proof** only after the existing #35 security/data/archive and #105 client/engagement identity/launch gates and hosting/cost entitlement are resolved. Keep the PWA local-first, preserve both divergent branches, and never present local save or mock receipt as remotely synchronized. $0/included only.
