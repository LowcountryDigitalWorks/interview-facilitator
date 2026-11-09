# Interview preparation and Owner Console bridge — PREP-BRIDGE-001

Status: **synthetic-only preparation (#106), human selection (#107), private overlay (#110), and handoff plan (#108) accepted; separately human-attested synthetic confirmation/CAS (#111) accepted; isolated recovery/lifecycle trial candidate; NOT connected, installed, launched, synced or pilot-accepted**  
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
| Human import/prefill and offline resume | DORMANT #107 human selection and #110 private overlay accepted; isolated synthetic client-confirmation/native IDB CAS trial accepted (#111); production import/persistence NOT IMPLEMENTED | Independent source review, actual authorized private adapter, offline restore and physical-device gates |
| Owner Console status card | NOT IMPLEMENTED | Product owner reconciles #11/PR #12, accepted #362 mapping, private Access, no client contents |
| Owner Console secure launch | NOT IMPLEMENTED | Protected destination, owner identity/authorization and approved client resolution; no URL tokens/IDs |
| Next-stage workflow adapter | SOURCE-ONLY deterministic private handoff PLAN accepted (#108); actual adapter NOT IMPLEMENTED | Validated private canonical export, provider-side conditional/idempotent write and client authorization |
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


## Source-bound private staging overlay — source-only candidate

The dormant `src/interview-prep-staging-overlay.ts` joins the human-selected ID-only proposal from the accepted #107 private UI with the accepted #106 preparation packet and pinned canonical 1.3 session. It revalidates both full source fingerprints, exact job/session/revision/pack identities, selected question/candidate IDs, current relevance, valid answer options, existing stored answers, and preexisting known-fact collisions before producing an **interviewer-only in-memory overlay**. Only one selection per question is permitted. Source ordering cannot pick a conflict winner, and hidden/pending questions are refused.

This avoids directly writing unconfirmed source text into `session.answers`. **Why:** the current schema 1.3 `projectSemanticReadBack` can render an unresolved answer's nonempty value on a client-facing surface, so using raw prefill could disclose unconfirmed private research. Instead, the overlay explicitly contains proposed values and private source references for a future protected interviewer-only review, and it never changes canonical JSON, known facts, confirmed answers, follow-ups, client-facing Read-back, Owner Console, or local/remote storage. A real confirmation/acceptance route requires a **separately reviewed, human-controlled, revision-safe** private adapter and client-safe projections, including explicit authorization and atomic replay/stale guards.

The trial browser journey covers actual human UI selection -> callback -> strict private overlay with no accepted answers or client-facing evidence. It is not installed in the live 1.3 app, not launched from Owner Console, not a client preview, and not authorized for real client data or production use. The current live PWA's presentation/read-back privacy contract must be re-reviewed before any source values enter canonical session fields.


## Distinct human-attested client confirmation + atomic CAS synthetic trial

`src/interview-prep-confirmation-trial.ts` is the next **dormant, synthetic-only** link from the accepted private, unconfirmed #110 source overlay. It deliberately refuses to treat human selection, confidence labels, a source reference, a workflow stage, or any earlier source statement as client acceptance. A human must separately **type the statement actually confirmed with the client** (which may differ from the original pre-interview source suggestion), identify the staged question/candidate, supply a canonical UTC event time, acknowledge that confirmation happened **in the interview**, and pass exact pinned job/session/source identities. The resulting canonical 1.3 edit is only a private draft until the authorized storage compare-and-save accepts it: new revision linked to the previous revision, `source: client-statement`, no copied private source reference, no implicit legal consent/quote/task. The unconfirmed source packet is not copied into session JSON, Markdown, Client Read-back or Owner Console. The client statement only becomes readable in Client Read-back **after the human-attested accepted write**, not merely because it appeared in source research.

The `ConfirmedPrepCompareAndSaveForReview` interface requires a trusted adapter to compare the **entire** stored canonical session, not just its revision ID, inside one atomic transaction; unknown/mismatched source must return stale/no write. Returning success must reproduce the entire expected session exactly or be rejected. `src/interview-prep-confirmation-idb-trial.ts` exercises this contract against **a distinct disposable native IndexedDB database** (`ldw-prep-confirmation-synthetic-trial-only`) and refuses any session whose client label is not explicitly prefixed `SYNTHETIC `. The Chromium suite checks actual close/reopen recovery, stale replay from a second connection and two-tab same-source competition where only one write can win. Database deletion is explicit and fails closed if other trial tabs hold the connection; no browser storage is changed in the live 1.3 PWA.

**This does NOT certify real client confirmation, verified consent, an authenticated operator/engagement, production IndexedDB lifecycle or data-at-rest encryption, mobile Safari/offline recovery, backup-and-restore, cloud sync or provider-side idempotency.** An operator-provided attestation is a software input, not proof that the customer said something. A later authorized private adapter must verify operator/engagement authority, enforce its own source CAS/retention/backup and supervise physical-device accessibility/privacy before a real-client pilot. The trial must remain unimported by `main.ts` and use synthetic records only. Incremental spend $0.


## Synthetic confirmed-session recovery and native blocked-lifecycle trial — candidate

`src/interview-prep-confirmation-backup-trial.ts` adds a **private**, versioned, strict canonical JSON backup envelope for validated `SYNTHETIC ` schema 1.3 interview sessions held in the isolated trial database. A SHA-256 content digest checks accidental corruption; the original pinned pack/answers, private running notes and revision lineage are preserved. It rejects unrecognized fields/schema, noncanonical bytes, altered content, oversized envelopes and any non-synthetic client label. The export returns **unencrypted plaintext** in caller memory; it never sends, downloads, schedules or stores it outside the current browser.

The explicit restore validates the entire envelope **before** native IndexedDB work and calls the existing synthetic trial `add` transaction, not `put`: an already-existing session is a failed transaction/no overwrite. Chromium regression exercises creating a backup, deliberately deleting the disposable DB, reopening, restoring exact confidential content, rejecting duplicate restores, rejecting tampered bytes, and then explicitly clearing the trial DB.

The native lifecycle browser matrix also exercises a deliberately **uncooperative** old tab blocking database deletion: the deletion function must report `blocked`, not falsely claim success; after the tab closes, a new trial DB can be opened and cleaned. The versionchange case verifies that an old connection closes on upgrade and reopening under the deliberately outdated version fails instead of attempting unsafe silent migration. These are **trial-only** database behaviors and are not evidence of real external client backup.

**Strict release limitation:** No off-device backup location, actual retention/restore test on another computer, cryptographic authenticity or encryption, client authentication, production data migration, mobile Safari/assistive-tech acceptance, customer-provided consent, provider sync, or live PWA integration has been authorized or implemented. A pure SHA-256 digest can be recomputed by an attacker and MUST NOT be used as proof of identity or integrity against malicious tampering. Do not put interview backups in public GitHub, debug logs or owner dashboard. Keep #34/#35/#105 open and use $0 incremental.


## Local interview next-step capture and private export — live PWA candidate

The offline 1.3 interviewer cockpit allows the human interviewer to **draft an optional follow-up action**, plus a suggested owner and due date, under the active question, separate from the answer and private note. The action is the only required field; if it is cleared, suggested owner/date metadata is removed with the proposal. An owner is not assigned and a date is not a customer commitment. The action remains inside the canonical local session's existing `answers[questionId].followUp` field, autosaves through the existing session revision/durability pipeline, and is removed when the operator clears its field. Drafting an action **does not** mark the question answered, accept a source fact, acknowledge client consent, create a ticket, or invoke any provider.

In the **private Review view only**, the app shows currently relevant proposed actions (pinned pack order, no hidden or pending branches) and offers **Export proposed next steps JSON (private)**. The handler awaits the local save barrier, validates the exact canonical session with the accepted `proposeInterviewNextStepsForReview` projector, and exports a `ldw.interview-next-steps.v1` `private-human-review-only` file. This is a governed work-item **proposal**, not a created task, approval, quote or customer communication. The source session's exact revision is carried for later downstream idempotency/review. No network, automatic upload or new workflow writer is introduced.

Conditional/pending questions can retain private draft actions locally, but the app now explicitly warns when the active question is still pending and when Review excludes deferred or inactive follow-ups. The private review list displays suggested owner/due metadata, while export includes only fields on currently relevant proposals. Before creating the file, the app checks the entire canonical session for edits made during asynchronous validation and refuses to export while any autosave work is pending; checking only a revision ID is insufficient when an edit has not yet been saved.

**Presentation/Read-back** explicitly excludes the action editor, internal action list and JSON export control; ordinary answer text remains separately subject to interviewer judgment before sharing. Exports contain proposed action text and session/revision identifiers, so they are confidential and must be retained in a specifically authorized client workspace—not pasted into public GitHub, Owner Console, URLs or shared chats. This local export does not establish that a real provider receives or creates a task. A later ClientOps integration must verify engagement, source scope, human action approval, conditional idempotent write and private retention, then return authoritative outcome status.

Manual mobile/iOS/Safari and assistive-technology release acceptance remains open; successful Chromium regression is not physical-device signoff. The core local interview remains operable offline with $0 incremental cost.
