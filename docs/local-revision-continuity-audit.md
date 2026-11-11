# Retained local revision continuity — synthetic-only audit

**Issue:** [Artifact and recovery contract #35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35). This small 1.3 PWA audit is **not** an off-device backup system, not an encrypted archive and not authorized for real-client workflows.

The existing IndexedDB `revision-history` store retains prior records during certain explicit transitions (including the synthetic-only human-confirmation CAS added in PR #121). Normal session autosave intentionally does **not** retain every intermediate edit. Therefore, the current browser's retained snapshots cannot be assumed to reconstruct full historical lineage.

A private operator working on a local **SYNTHETIC** session can choose **Check retained local revision continuity** in Private Review. The app reads the *current session plus only that session's archive keys and records* using one read-only IndexedDB snapshot. It validates pinned schema/pack, exact session and archive key identities, bounded record count and parent-chain shape. It reports only aggregate counts and one of four local statuses:

- `none-retained`: no prior local snapshots.
- `linked-locally`: retained snapshots present a contiguous parent chain ending at a root.
- `missing-link`: current parent chain references an absent archived revision.
- `unlinked-snapshots`: retained records exist outside the current parent chain.

Malformed or conflicting archived entries fail closed with a generic operator message, not a partial PASS. The actual synthetic Chromium confirmation journey is expected to reveal a **missing-link** result even with one successfully archived immediate parent: an earlier ordinary autosave revision was not retained. This is an intentional, evidence-based warning, not a reason to suppress the audit or claim completeness.

A fully connected local chain is still **not proof** that all edits were archived, that the local database cannot be tampered with, or that an off-device encrypted recoverable artifact exists. This audit does not output raw session data, create any file, write to IndexedDB, transmit a report, or touch CRM/Owner Console. Private audit result and controls disappear in Presentation, on navigation, or after session changes.

**Release gates remain open:** authenticated per-engagement owner/client authority, approved private off-device encrypted storage and key management, a portable versioned multi-revision export, origin-independent import/recovery, atomic restore/rollback, physical iOS/Safari, screen-reader testing, and real-client pilot/production authorization. The current `Export full JSON backup` is a current-session content copy, **not** a complete source revision-history archive.

All source and browser fixtures must be synthetic. Keep the public repository free of private data, credentials and provider URL/IDs. No new dependencies, external service, new cost or deployment is authorized by this work.
