# S2A-2 — synthetic server transaction and replay simulator

**Status:** source-only, in-memory TEST PROOF. Not an authenticated backend, durable service, cloud sync, customer storage, or real device pilot. The production 1.3 PWA remains strictly local-first and is **not wired** to this simulator.

Authority: [architecture #4](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4), [roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), [owner parent business-operations #753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753), [S2A policy PR #144](https://github.com/LowcountryDigitalWorks/interview-facilitator/pull/144), [client identity stage #105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105) and [recovery/key custody #35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35).

## Why this slice

The reviewed S2A pure planner says when a request is *eligible* for a synthetic append or replay, but alone cannot serialize two requests, persist a conditional remote revision, or prove idempotent receipts. A future protected server must do those operations **atomically** and re-check permissions on each operation. This isolated class provides a bounded, deterministic demonstration of that algorithm, with only public-safe synthetic metadata.

## Source-only model

- `src/synthetic-server-transaction-s2a2.ts`: an **in-memory** `SyntheticMetadataServerTransactionTrial`. A distinct four-part `tenantId/clientId/engagementId/sessionId` key isolates each simulated object's state, permission fixture, immutable revision-head history and scoped operation receipts.
- `setSyntheticGrantForTest` is privileged **fixture setup**, not an authentication provider or user-controlled enrollment API. `appendForTest` receives a *claimed* actor string from a synthetic test. Neither possession of the string nor the `server-policy-test-fixture` marker authenticates anyone. The planner evaluates a currently active grant fetched from the simulation's private map, rather than trusting one supplied in the caller's append request.
- Per-resource FIFO promise serialization models the critical section; **a production deployment MUST replace it with actual database-level atomic CAS and durable state**, because promises do not serialize across Worker instances/processes or survive restarts. Within the simulated critical section, append re-reads the grant, selected head and scoped receipt, invokes the accepted S2A policy, then constructs a private copy of selected head, immutable metadata history and matching receipt.
- **One in-memory map swap** is the synthetic transaction commit point. A test fault before commit leaves all records untouched. A test fault after commit but before delivery retains the receipt and selected revision so the exact retry returns `synthetic-replayed` and not a duplicate write. Reusing a historical revision ID, wrong pack/session, stale parent or sibling branch never overwrites history. Concurrent attempts from one parent serialize: one wins, the other preserves a conflict.
- Revocation or removal of `append` rights takes effect before the next queued append/replay. Even a previously committed operation cannot fetch its stored receipt through an unauthorised replay request.
- `snapshotForTest` is a deliberate **unprotected test inspection API**. It must never appear in an external API or production bundle. It returns metadata only. Denied append results carry no remote object identifiers or reason.
- No private session snapshots are sent to, stored by, or returned from this simulator. A SHA-256 metadata digest is not a signature or confidentiality proof. **This model cannot demonstrate server-side verification of the complete canonical uploaded session, actual fsync durability, encrypted storage, authenticated tokens, or client access.**

## Synthetic unit acceptance

`tests/synthetic-server-transaction-s2a2.test.ts` covers:

1. A synthetic first-append and matching scoped retry: one selected revision, one retained head, one receipt and no client notes in metadata.
2. Simultaneous divergent sibling edits: exactly one commit, one conflict, no last-write-wins, with the losing branch retained by its offline device.
3. Injected abort *before* synthetic commit: no partial revision/receipt; exact retry succeeds.
4. Injected lost response *after* synthetic commit: retry returns the previously created receipt without duplicate commit.
5. Revoked actor, assignment or append privilege: deny on every request, **including replay**.
6. Four-part tenant/client/engagement/session isolation; same metadata IDs scoped independently when deliberately authorized in two synthetic engagements.
7. Forged operation ID, 1.4/extra fields, hostile getter/accessor and stale initial expectation: denied without state changes or accessor execution.
8. Reusing an older revision ID: immutable history preserved, selected head unchanged.
9. Concurrent identical retries: one commit, one replay, one receipt.
10. Anonymous/unassigned actor denied with no remote metadata disclosure.

All records and actor names are intentionally synthetic. No real authentication or confidential interview text may be added to source/CI.

## Mandatory external implementation gates

**No provider selected or provisioned here.** Before S2B (real protected **synthetic-only** two-device exchange), confirm the actual existing-entitlement $0 host, private identity and engagement/tenant actor resolution from a trusted account, session source and grant revocation, per-request object authorization, strict encrypted transport and server-authenticated receipt, immutable versioned full session storage, atomic durable `CAS + history + scoped receipt` via provider transaction and affected-row checks, retention/deletion/backup/key custody and client consent. Cross-process concurrency, quotas, outage, replay and exact provider return must be tested against that actual private host; do not substitute this JS simulator. Owner/security/ClientOps #35/#105 and real-client pilot gates remain open.

The Cloudflare Workers/D1 study in [architecture #4](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4#issuecomment-6874352844) is a **candidate only**, not permission to create D1, Access, Worker routes, or credentials. Any device installation and physical Safari/VoiceOver approval is separate. Native Tauri desktop packaging is optional, only with demonstrated PWA limitations.

## Source-acceptance gate

This isolated module/test/document set must pass hosted exact-head unit, browser, build and shell checks; receive an independent author-excluded H0/M0 review on a frozen exact BASE/HEAD/TREE; then a guarded expected-head merge and independently verified exact merged-main PUSH CI terminal success. Neither source acceptance nor mock in-memory atomicity authorizes real client synchronization.
