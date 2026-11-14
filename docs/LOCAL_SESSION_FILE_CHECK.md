# Read-only local session JSON check (1.3 only)

**Status:** active Home UI source change, pending exact-head independent review and release gates. Authority: [Interview Facilitator #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35). This is not an encrypted backup feature.

## Operator workflow

On Home, choose **Check session JSON (read-only)** and select a manually downloaded **1.3 single-session JSON file** (up to 5 MiB). The browser validates the complete schema and compares the canonical contents against the saved session with the same identity **in this same browser/app storage context**. It reports one of five fixed statuses: invalid/unsupported, valid exact match, valid divergent saved copy, valid but no same-ID local copy, or valid with unreadable/unavailable local comparison. The result reports **no client labels, source values, private notes, file names, IDs, or error internals**.

The action is read-only and offline: it **never imports, edits, deletes, repairs, exports, uploads, decrypts or syncs** a session. It does not commit any data to IndexedDB and cannot replace the regular import button. The Home storage error does not disable this independent file check; when the local source is unreadable the result is explicitly **unverified**, not an invented empty browser. Switching screens disposes the result DOM; while the check runs its button is disabled.

## What the checks do not prove

- A match covers one complete **current 1.3 JSON object**, not all retained history or older autosaves.
- It does not prove the downloaded file was saved to an independent off-device destination, survived a device failure, or can be recovered on physical iOS or installed Home Screen PWA.
- It is **not authenticated, encrypted, signed, or tamper-evident against malicious rewriting**. Strong archive confidentiality, recovery material, retention, owner/security E2B decisions and recovery drills remain [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35).
- A comparison is against the saved local revision **at the time of reading**. A later autosave, concurrent tab, or other device can change local state; it is not a continuing lock.
- 1.4 JSON is intentionally **unsupported** until the separate [#34](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/34) activation/Restore gate.
- Actual iOS/Safari/VoiceOver, offline storage eviction and physical device file handling require separate testing and approval. No customer release, regulated data, new backend, vendor, secrets, account, or spend is authorized by this slice.

This is a safer operator preflight before manually copying a 1.3 JSON export. It must never be labeled a verified **secure backup**.
