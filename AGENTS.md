# Agent contract — interview-facilitator

This public repository owns implementation history and governed technical truth for the reusable Interview Facilitator core.

Before material work:
- re-read live repository state, open issues/PRs/checks, and this file;
- re-read `LowcountryDigitalWorks/business-operations#753` and newer owner-direction comments;
- follow the canonical LDW execution/handoff, information-placement, and chat-lifecycle standards in `business-operations` when applicable;
- treat live GitHub/system state as authoritative over chat summaries and older handoffs.

## Product boundary

Human-led, offline-first interview/discovery cockpit. The interviewer remains in control. Core interviewing must not require internet, Google, AI, Owner Console, or an LDW backend.

## Public data boundary

Use synthetic/public-safe data only in source, tests, fixtures, screenshots, issues, PRs, and CI. Never add real client interview records/context, credentials/tokens, private Drive identifiers, PHI, CUI, payment data, customer secrets, or regulated material.

No analytics/ad/tracking SDK by default.

## Architecture

Prefer deliberately boring architecture: TypeScript, Vite, minimal dependencies, IndexedDB, deterministic schemas/exports, no backend database for V1. Do not introduce React unless measured UI/state complexity materially justifies it.

JSON is canonical machine-readable session truth. Markdown is generated deterministically from JSON. Pack schema versions are independent from session schema versions.

Keep application-shell cache, local interview data, and future authenticated remote responses separate.

## Change control

Meaningful source work uses feature branch -> PR -> exact diff/candidate validation -> independent exact-head review -> merge only after accepted gates. An authoring lane must not self-certify its candidate.

## License posture

License selection is deferred to a portfolio-wide LDW review. Do not add a LICENSE file or represent the repository as licensed until owner authority resolves that gate. Do not copy third-party source merely because it is open source.

## Consequential boundaries

No new spend/overage, external account/terms acceptance, production/provider/security mutations, credentials, customer commitments, or publication of client/private data without the applicable owner gate.
