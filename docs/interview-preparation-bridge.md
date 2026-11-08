# Interview preparation and Owner Console bridge — PREP-BRIDGE-001

Status: **synthetic-only source contracts and human-selection browser trial accepted; deterministic downstream handoff plan candidate; NOT connected, installed, launched, synced or pilot-accepted**  
Owning authority: [Interview Facilitator #105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105), [roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), [Owner Console #16](https://github.com/LowcountryDigitalWorks/owner-console/issues/16), [client-operations parent business-operations #753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753).

## Owner-directed outcome

When an **authorized client** enters Interview Prep in the owning client/workflow system, the existing LDW workflow automation should assemble useful context from approved LDW sources without Eddie having to reconstruct it manually. Eddie can then see a status and launch the **protected interview experience** from Owner Console. Interview output should be fed back into the client's governed work and subsequent *proposals*, subject to human authorization where consequential.

The Interview Facilitator remains a human-led, offline-first application. Client data does **not** belong in Owner Console's public fixtures/Git history or a generic dashboard backend.

## Intended end-to-end flow

```text
Authoritative client/workflow stage -> authorized event, no new control plane
  -> private allowlisted evidence collectors (client-ops, governed Drive/docs, prior notes)
  -> versioned confidential interview prep packet (owner client workspace)
  -> strict pinned-pack / revision check and private human review
  -> verified accepted facts promoted by explicit human action only
  -> offline-first Interview Facilitator session (canonical JSON + internal Markdown)
  -> guarded private output adapter (idempotent client workspace write)
  -> proposed next steps (no automatic external commitment or task side effect)
  -> accepted owning workflow/human decision -> next stage
  -> sanitized status/verified protected launch descriptor -> Owner Console read model
```

### Stable source and idempotency ownership

- The owning **client-operations workflow** owns the authorized client record, event identity, stable job key, source access, retries, and deduplicated packet issuance. It must validate that every source record belongs to the *same authorized engagement*; the source-only module cannot verify identity or privileges.
- Evidence in private packets carries candidate ID, pinned question ID, proposed text, source system, private source reference, observed time, and unverified/source-stated classification. Conflicting proposals **remain conflicts**; source ordering cannot automatically pick a winner.
- The packet binds to an exact session ID, session revision, and pinned pack digest. Source absence is **unknown**, not completion or healthy readiness. No freshness SLA/clock or source connectivity is invented.
- Do not put provider tokens, passwords, MFA/recovery, payment, regulated data, unnecessary secrets, or unrestricted raw documents in packets. Apply approved field-level allowlists and private storage retention.
- The first source-only module deals with already-created canonical **schema 1.3** sessions. It does NOT create a client session, migrate to schema 1.4, automatically import candidates into answers, or write browser storage. The later adapter must separately prove safe, explicit human promotion and stale-session handling.

### Owner Console read boundary

- Owner Console is an already Access-protected, **read-only** static proof. Its [OC-003 #11](https://github.com/LowcountryDigitalWorks/owner-console/issues/11) / [PR #12](https://github.com/LowcountryDigitalWorks/owner-console/pull/12) is still the serialized one-shot private snapshot path. Do not collide with this writer or deploy a new mutation/action engine.
- Only a **generic status** may enter the accepted `#362` renderer-neutral sanitized snapshot after a private production mapping is independently accepted. Current source-only `projectOwnerInterviewPreparationForReview()` deliberately returns `launch.available=false` and `href=null`: a client-aware link, password, token or opaque session ID must not be embedded in a public fixture, URLs, analytics or logs.
- In a future reviewed private integration, verify authenticated owner session, authorized client selection and target before allowing `Launch interview`. Do not expose private file links or client labels in URL parameters. Validate Access/logout/back-forward cache, source freshness and missing-data states. `waiting` does **not** imply `Needs Eddie` without explicit accepted escalation.
- Owner Console's permanent role is **status and safe navigation**, not a source of truth, private interview store, agent, CRM, action executor, or entitlement bypass.

### Post-interview work

- A deterministic private adapter emits canonical JSON and internal-readable Markdown to the approved client's workspace only after versioned validation, with idempotent object identity and a verified off-device restore plan.
- The pure `proposeInterviewNextStepsForReview()` projects only *currently relevant* follow-ups into a **private review-only** proposal; inactive branches are excluded. It creates **no tasks, tickets, contacts, quotes, purchases, proposals or provider writes**.
- Workflow execution only after authorization by the owning client-operations system and the relevant human decision gate. A complete interview is not equivalent to complete coverage, verified facts, customer agreement or consent.

## Current verified scope and next gates

| Stage | Status | Exit evidence |
| --- | --- | --- |
| Public source-only prep/result contracts | ACCEPTED — #106 merged with exact-head IR + postmerge CI | Strict packet/unit proof; no live deployment |
| Provider source mapping and automatic prep trigger | NOT IMPLEMENTED | Approved account access, field allowlists, engagement identity, retries, private packet retention and provenance |
| Human import/prefill and offline resume | DORMANT synthetic human-selection browser trial ACCEPTED (#107); import/persistence NOT IMPLEMENTED | Independent source review then actual private adapter, offline durability, conflict and stale revision handling |
| Owner Console status card | NOT IMPLEMENTED | Product owner reconciles #11/PR #12, accepted #362 mapping, private Access, no client contents |
| Owner Console secure launch | NOT IMPLEMENTED | Protected destination, owner identity/authorization and approved client resolution; no URL tokens/IDs |
| Next-stage workflow adapter | SOURCE-ONLY deterministic private handoff PLAN candidate; actual adapter NOT IMPLEMENTED | Validated private canonical export, provider-side conditional/idempotent write and client authorization |
| Real-client pilot | BLOCKED | Explicit owner pilot approval, security/privacy, actual off-device backup + restore, physical iOS/Safari/AT and offline tests |

## Follow-on implementation order

1. Strict packet validator and projection accepted under #105 / merged PR #106; retain live PWA 1.3 and dormant 1.4.
2. In the **owning client workflow**, identify earliest approved Interview Prep stage signal, authorized sources, data-classification policy, and stable packet store; only synthetic/dry-run until data path is approved.
3. Add a human-only preview/acceptance import workflow and rehearse conflicts/staleness offline.
4. Coordinate a **separate Owner Console** source candidate under #16 *after* #11/PR #12 owner disposition. This may start with clearly labeled synthetic/unavailable link-only status; do not route real clients to localhost.
5. Independently review and exercise one private protected launch, one authorized client and one idempotent result write in a governed test workspace, then advance the supervised pilot gate.
6. Later only as observed value warrants: additional packs, bounded attachments, approved provider adapters, optional human-reviewed AI enrichment.

$0 incremental; no new accounts, billing, license claims, provider mutations, real client records in public GitHub/CI, or production activation authorized by this document.


## Human-selection trial — implementation scope and caveats

The dormant `src/interview-prep-review-ui-trial.ts` is a **synthetic-only** private user-interface proof under #105. It renders source values and conflicting candidates in a clearly private interviewer-only screen. Nothing is selected by default. A person must choose a single candidate per relevant question, acknowledge that the information still needs client confirmation, and explicitly prepare an in-memory proposal. Hidden/irrelevant questions cannot be selected. A full canonical session and preparation-packet digest are both recomputed immediately before issuing the proposal. The only callback payload is a bounded list of **question ID + candidate ID**, with source/session fingerprints; it never includes client labels, source references, proposed values, credentials, or automatic answer/task mutations.

This **does not** populate interview answers, persist a prepared packet offline, synchronize any source, establish engagement/job ownership, or provide a protected launch. The future, independently reviewed adapter must bind the prepared job to an authorized client/workspace and verify the digest and exact canonical source in the same authorized transaction where any promotion/persistence occurs; this browser callback alone cannot guarantee race-free downstream writes. An independent protected-host/UI privacy and physical device/AT gate remains mandatory. Do not screen-share the private preparation UI.

A synthetic release is not an approved client-data pilot.


## Downstream private handoff plan — source-only candidate

`src/interview-handoff-plan.ts` proposes three **private** artifacts for a reviewed canonical 1.3 session: validated canonical JSON, deterministic internal Markdown, and currently relevant follow-up suggestions. The caller must explicitly assert that an operator reviewed the draft and provide a bounded opaque engagement reference plus exact session/revision/pinned pack identities. Malformed or conflicting identities fail closed. A private artifact's stable idempotency identity is derived from version, opaque engagement reference, session ID, revision ID, pack digest, artifact kind, and content SHA-256. Identical retries yield identical bytes and keys; changed internal content or a newer revision gets different keys.

The outputs **contain confidential interview material** and must never be placed in Owner Console, URLs, public GitHub artifacts/logs, or unsecured storage. The plan has no destination, HTTP calls, provider credentials, local database, task creation, customer consent, real client approval, or capability to write. **A deterministic idempotency key is not idempotent delivery**: the future private adapter needs its own allowlisted client/workspace binding, authentication, unique-key conditional object creation/update, conflict resolution, retention and rollback, and verified off-device backup/restore. The engagement reference supplied to this pure function is **not independently verified** and must not be treated as proof of authority. Proposed next steps are informational, never autonomous client commitments.

All work here remains synthetic-only, dormant and governed by [#105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105). Source acceptance is not production deployment or pilot authorization.
