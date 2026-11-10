# Human-selected next-step review — source-only bridge

Authority: Interview Facilitator [#105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105), [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35), and ClientOps [#175](https://github.com/LowcountryDigitalWorks/business-operations/issues/175). The current live PWA remains schema 1.3. No provider integration, launch or release is authorized here.

## Scope
`src/interview-action-review.ts` stages **only explicitly operator-selected, currently relevant** `ldw.interview-next-steps.v1` proposals from a fresh, validated full canonical session. It rejects missing/duplicate/hidden/pending question choices, unknown fields, changed canonical private notes despite unchanged revision, changed proposals, invalid calendar dates, unbounded owners/actions, and unsafe engagement key syntax. It never modifies the session.

Proposed due dates are intentionally free-text in the live offline interview so existing notes are not discarded. This separate downstream boundary requires exact, real `YYYY-MM-DD` for any selected proposed action with a date; malformed dates are **rejected, not silently corrected, dropped, or scheduled**. Action text, owner suggestions and dates are not client commitments.

Stable `retryKey` represents the same private engagement key, full canonical session digest, revision, question, proposal contents and normalized due date. Review time does **not** vary retry identity. The retry key by itself does not prevent duplicated remote tasks and does not prove identity or approval. A future adapter needs atomic destination-side idempotency and authoritative write readback.

## No production/provider authority
- Source-only pure function and synthetic Vitest; **not imported into live `main.ts`**.
- No SuiteDash, Activepieces, Google Drive, Owner Console, CRM, GitHub task, account change, client message, customer commitment, login, token, network, database or storage.
- The opaque engagement key is **caller-supplied and not authenticated**. The authorized ClientOps actor must confirm private actor, engagement and source authority before this component can be used with real records, and must compare exact canonical source **within its own conditional write** immediately before external action.
- A typed `operatorSelectedForReview: true` is an explicit software assertion, **not independent evidence of client consent, legal approval, or actor authentication**.
- The result is confidential. Never put it in Owner Console, public GitHub/CI artifacts or logs, URLs, shared messages or client Presentation mode.
- Full private handoff PR #116 remains separate. This module does not compete with its writer or accept its source/release gate.
- Exact-head hosted CI, separate independent H0/M0 review, guarded merge and postmerge verification are still required. No production/pilot authority from source acceptance. Incremental spend $0.
