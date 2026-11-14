# S1 synthetic offline-sync revision planner (transport neutral)

**Status:** Source-only candidate. Does not activate remote sync, queued storage, accounts, encryption, PWA UI, desktop installer or real-client work. Governing architecture: [#4 SYNC-ARCH-001](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4#issuecomment-6872727322); source roadmap [#5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5#issuecomment-6872731773); parent [business-operations#753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753).

## Scope of this first pure prototype

- Derive a small **metadata-only** 1.3 revision head from the fully validated canonical local session, with stable session/revision/parent IDs, pinned pack digest, canonical SHA-256 snapshot digest, and version tag. Use the same deterministic operation ID on retry; no client values or notes in the head.
- Plan only one-step known parent-child relations and exact same revision. An absent remote head yields a local offer only if the device has no dirty edits. Matching metadata is `already-aligned`; known local ahead is `offer-local`; known remote ahead is `review-remote`, **never auto-write**. Unknown ancestry and concurrent offline branches preserve both heads as a `preserve-conflict` proposal; never last-write-wins or semantically merge client facts.
- Reject mixed session identity, pack digest, unsupported version/1.4, corrupt extra metadata and invalid revision IDs. Unsaved local edits hold any remote change. Bound canonical session bytes to 2,000,000 before deriving a head.
- A matching **synthetic ACK** returns `candidate-ack-matched`, not `SYNCED`. Only a later approved **authenticated** transport and verified durable remote storage operation may change any real user-facing sync state. Wrong/missing ACK must retain a future outbox item.
- No actual outbox persistence, networking, crypto key/storage, server/provider, device identity, transport retry, authenticated authorization, conflict UI, remote data, attachments, installer, or customer release in S1. The future adapter must separately provide atomic offline local write+enqueue, replay-safe queue, remote CAS+idempotency, authenticated fetch, conflict retention, per-engagement isolation, error/revocation paths, restoration/retention policy and physical-device testing.

## Test expectations

Seven synthetic Vitest cases cover stable retry identity, private-data absence, rejected 1.4/bad fields/over-size, local vs remote ordering, dirty local hold, concurrent offline diverged branches, invalid cross-client/pack data, and exact ACK gating. Tests use fictional local sessions and no credentials/network.

**Limits:** a SHA-256 digest alone proves neither source authenticity nor confidentiality. The planner knows only immediate parent links, not a full trusted DAG. It must never turn a `review-remote` candidate into actual remote overwrite without a separate source-validated strict local compare-and-save transaction and explicit human review where needed. A green test proves only this pure source policy, not an available sync service or secured cloud backup.

**Next gate:** independent exact-head H0/M0 review and full hosted CI, guarded merge and exact main PUSH CI. Only afterward scope an S1B synthetic local outbox without any provider; S2 two-device secure pilot requires owner/security hosting and data classification approvals. $0/included, one source writer, no LICENSE addition or new dependencies.