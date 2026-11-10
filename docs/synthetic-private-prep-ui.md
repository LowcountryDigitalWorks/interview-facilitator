# Synthetic private preparation review — local PWA trial

Status: **source-level trial only**. [PREP-BRIDGE-001 #105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105). No customer/client pilot, provider source, authentication, Owner Console launch, CRM trigger, background upload or approved private storage path is implied.

## Narrow live 1.3 experience

In a local interview whose project label begins with `SYNTHETIC `, choose **Review interview** and then explicitly **Exit presentation** to enter **Private Review** (Presentation intentionally hides all internal tools). The Private Review screen offers a local **Load synthetic preparation JSON** control. The packet must be ordinary bounded JSON, with `jobKey` beginning `SYNTHETIC-`, and every evidence candidate must use a `SYNTHETIC ` value and `SYNTHETIC-` source reference. A maximum 512 KiB local file is read in tab memory and checked against the **selected exact session and pack revision**. Other/mismatched/malformed files are rejected without writing or retaining answers. The file is never uploaded or saved to IndexedDB, service worker cache, URL, GitHub, or an external provider. The trial is not shown for ordinary client sessions.

The existing private review component renders conflicting source values using DOM `textContent` and does **not** choose facts automatically. A human can select candidate IDs and check an explicit acknowledgment to exercise a transient **proposal requiring separate client confirmation**. The trial receiver intentionally discards that proposal rather than saving, submitting or carrying it forward; return to the interview to capture client-confirmed statements separately. Neither the proposed value nor the source reference is copied into session answers or a public Read-back. No task, message, provider write, CRM update, consent event, or completion flag occurs.

**Navigation boundary:** Returning to the interview, opening another session, switching to Presentation, or re-rendering Review disposes the private candidate widget and clears the loaded packet and proposal from app state. Stale asynchronous file reads are invalidated. Presentation shows no import control, source values, source references, or reviewer choices; exiting Presentation does not restore discarded content. The operator must select a fresh local file to repeat the trial. A dedicated Discard action clears the trial without changing the interview.

## Synthetic packet shape

The accepted `ldw.interview-prep.v1` packet fields are `schemaVersion`, `jobKey`, `sessionId`, `expectedRevisionId`, `expectedPackDigest`, `preparedAt`, and `candidates` containing `candidateId`, `questionId`, `proposedValue`, `sourceSystem`, `sourceRecordRef`, `observedAt`, `confidence`. A demonstrator can obtain the current session/revision/pack digest from a *synthetic* local canonical session backup. Only source-safe synthetic fixtures should ever be used. File size and markers are trial safeguards, not a complete DLP classification or approval to use real customer records.

## Unproven deployment and pilot gates

No authenticated actor↔client↔engagement authorization; no SuiteDash stage-event/source allowlist/private packet provenance pipeline; no imported research becoming confirmed session answers; no provider idempotency; no protected private host/Owner Console link; no off-device encryption or revision-lineage restore; no physical Safari/iOS or screen-reader certification, and no production/customer approval. The offline-first interview still works with zero network. Future real-client integration requires separate independently reviewed, consent-bound private adapter and approved source/destination security before any live confidential data is used.

This PR should pass exact-head hosted typecheck/unit/build/PWA/dormant/browser tests and distinct author-clean independent review before Product ORCH source integration. Incremental cost $0.
