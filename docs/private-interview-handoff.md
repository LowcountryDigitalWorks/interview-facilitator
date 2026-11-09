# Private interview handoff bundle — offline source contract

Status: Candidate; production/client integration **not** active. Governing issues: [Interview Facilitator #105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105), [artifact #35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35), [ClientOps #175](https://github.com/LowcountryDigitalWorks/business-operations/issues/175), [Owner Console #16](https://github.com/LowcountryDigitalWorks/owner-console/issues/16).

## Purpose

After a human-led interview, the authorized interviewer can export one **private local JSON file** that contains the validated canonical schema 1.3 session, its deterministic internal Markdown review, and the strictly derived current human-review-only next-step proposals. This reduces the risk that a future client workflow accidentally receives the Markdown without the source evidence, or actions without the exact interview revision.

In the offline PWA, open **Review interview → Exit presentation → Export private handoff bundle JSON**. The button is intentionally unavailable in Presentation mode. Export requires the existing local autosave flush, full canonical session snapshot equality, no pending write, and unchanged session/revision/private view. It does not automatically send, share, email, sync, or create a task.

## Contract

The complete file is canonical JSON plus one trailing newline with the schema tag `ldw.interview-private-handoff.v1`, `kind: private-human-review-only`, and these fields:

- `source`: exact `sessionId`, `revisionId`, pinned `packDigest`, `updatedAt` and SHA-256 of the canonical session.
- `canonicalSession`: **complete private 1.3 interview** including client label, answer state, hidden/pending retained evidence, source notes, and running notes.
- `internalMarkdown`: deterministic Markdown from the same canonical session; an internal readability aid, **not** the restorable truth.
- `proposedNextSteps`: `ldw.interview-next-steps.v1`, `private-human-review-only`, exact session/revision, **currently relevant** question action/owner/due proposals; no pending/inactive follow-ups.
- `notice`: neither customer approval nor task/quote/message/provider write.

The producer and pure `validatePrivateInterviewHandoffForReview` parser enforce a fixed version/allowlisted shape, 5 MB total UTF-8 size ceiling, pinned source identity, full canonical session digest, regenerated Markdown and regenerated proposal parity. Repeated exports of identical source bytes are deterministic. **SHA-256 detects accidental change only**, not cryptographic authenticity: anyone able to alter a file can recompute an unkeyed hash. The file is **unencrypted** and must not be left in a public download location.

## Strict downstream boundary

A future ClientOps adapter must first independently verify **who** is acting, **which client engagement** the source belongs to, its permissions/retention rules, the origin and latest accepted revision, and private storage authorization. It must validate this envelope and independently normalize/validate suggested due dates (which may be free-text for legacy preservation). It must use idempotent conditional writes and an explicit human decision before any consequential task, customer message, quote, credential action or other provider mutation.

For internal technical work only, use the accepted canonical #236 intake path after explicit sanitization: **never send the raw session, source IDs, private Markdown or client action text to public GitHub issues/CI**. Owner Console consumes only separately accepted sanitized readiness, never this bundle or its filename/link.

No external service/provider connection, multi-device sync, authenticated client workspace, encryption/signature, legal consent, tested off-device backup/restore, physical Safari/iOS/assistive-tech certification, production deployment or real-client pilot is claimed by this feature. Offline interviewing remains usable without all of them. Incremental spend $0.
