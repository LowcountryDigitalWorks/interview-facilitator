# E2A — portable interview archive confidentiality: proposed threat model

**Status: DESIGN CANDIDATE / NOT APPROVED FOR IMPLEMENTATION OR CLIENT DATA.** Owning issue: [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35); roadmap [#5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5). This source-only document is a bounded decision gate; it does not implement encryption, a Restore control, credentials, storage, a client workflow, or an algorithm certification. It uses no real records or secrets.

## Existing boundary

- The live Interview Facilitator 1.3 core is offline-first and stores canonical session JSON in browser IndexedDB. A generated Markdown read-back is **not** a backup format.
- The current multi-revision portable JSON archive holds **only revisions actually retained**, possibly omitting earlier autosaves; `complete-to-root` describes its *included ancestry*, not guaranteed lifetime completeness.
- `SHA-256` of unkeyed portable JSON detects some accidental corruption but does **not** authenticate origin or stop attacker rewrites (attacker can recompute digest).
- E1 `importSyntheticPortableArchiveFreshOrigin` demonstrates a **test-only**, strict-IDB-transaction import. Its fixed capability label is not authorization. This API is not connected to customer Restore UI.
- Browser-local data and an isolated downloadable file are not, by themselves, off-device survivability, confidential storage, trusted client identity or legal retention compliance.

## Assets, actors, and trust boundaries

| Item or boundary | Risk to control |
| --- | --- |
| Session answers, interviewer notes, private source classifications, retained revisions | Confidentiality; avoid placing any of them in unencrypted headers, filenames, logs, GitHub artifacts, analytics or error reports |
| Portable file after export | A person with the file may inspect, change, truncate, replay or delete bytes; on weak passphrase, can perform **offline guessing** without interacting with the app |
| Encryption material (passphrase, random export key, recovery code) | Theft, mishandling, forgotten key, accidental clipboard/cloud/telemetry capture, unauthorized sharing; **lost sole secret means lost recoverability** |
| Browser / PWA execution context | Malicious extensions, compromised device/app origin, XSS and injected JS are **not** solved by file encryption once decryption occurs |
| Destination storage | Deletion, vendor failure, inadvertent sharing, account takeover, sync conflict, retention/legal holds and wrong-owner Restore; encryption is not access governance |
| Restore source and target | Hostile or stale files, duplicated session IDs, conflicting histories, lineage gaps, untrusted pack snapshot and overwrite of an existing active interview |
| Cross-device/Safari | Crypto and file API availability, memory/CPU pressure, web-origin storage eviction; real Safari/VoiceOver requires physical testing |

### Security objectives (not yet satisfied)

1. **Confidentiality at rest:** encrypt every private byte (including labels/notes/revision contents); leak as little as possible via outer metadata and file names.
2. **Authenticated integrity:** ciphertext and security-critical envelope metadata must be integrity-protected together by a standardized authenticated-encryption construction. This is **not publisher identity** or evidence that a person obtained informed client approval.
3. **No silent downgrade:** unknown versions/algorithms/KDF cost parameters, missing authentication tags, malformed encoding, overlarge inputs or unsupported browser capabilities fail closed *before plaintext is exposed or any IDB write starts*.
4. **Key lifecycle:** independent design and review for randomness, wrap/derive choices, memory lifetime, key-loss acknowledgment, rotation, portability and recovery custody; no secret stored in session JSON, localStorage, code, CI or artifacts.
5. **Correct restoration:** authenticate/decrypt and validate the full plaintext archive *before* the isolated E1 transaction. Never overwrite an existing session silently. On post-commit readback error, report commit ambiguity rather than falsely claiming rollback.
6. **Verifiable off-device process:** user has a separately stored and tested file **and** recovery secret; a single browser or user account is not sufficient disaster recovery.
7. **Consent/scope:** no real client or regulated data without classification, authorized destination, retention/revocation policy, owner or client approvals where required, and separately reviewed UI.

### Explicit non-goals

Not a login/auth system, client authorization, immutable audit trail, all-edit history, compliance certification, assurance against a compromised endpoint, anti-replay trust service, zero-knowledge cloud sync, key escrow, secure deletion, provider OAuth, or a production recoverability guarantee. No new provider, database, package, encryption library or remote sync is authorized by this document.

## Candidate key-custody options — DECISION REQUIRED

| Candidate | Benefit | Unresolved risk |
| --- | --- | --- |
| A. User-held **random high-entropy recovery secret** | Avoids low-entropy passphrase guessing if generated/handled correctly | Recovery UX, copy/storage safety, loss without escrow, cross-device file+secret transport |
| B. User-chosen passphrase with **audited memory-hard KDF** | Familiar recovery ceremony | Weak passphrases, mobile performance/memory, offline guessing, dependency supply chain, parameter migrations |
| C. Browser-native PBKDF2 compatibility path | Native WebCrypto support and no additional KDF runtime | PBKDF2 is less memory-hard; cost/target-platform benchmark and security approval needed; should not inherit password-hash benchmark uncritically |
| D. Managed per-client key custody | Could support organizational recovery and rotation | Governance, external account/provider, entitlements, auth, audit, retention and spend require separate approval |

**No option is selected.** Argon2id/PBKDF2 recommendations for password **storage** are not automatically proof of an archive password **key-encryption** design. The chosen workflow must include an explicit offline attacker-cost study and physical-device tests.

## Review checklist before executable encryption

- [ ] Privacy/security owner approves data classification, threat assumptions, encryption/manifest format, key lifecycle, and supported devices.
- [ ] Separate human decision selects recovery material custody, destination/retention, loss behavior and who may decrypt/restore a client file.
- [ ] Versioned envelope, size limits, nonce uniqueness under any encryption key, complete authenticated metadata binding, KDF cost bounding, and algorithm migration are specified/tested against malicious inputs.
- [ ] Key generation/wrapping/encryption uses reviewed standard primitives; no custom cipher or unreviewed crypto dependency.
- [ ] Synthetic-only roundtrip, wrong secret, altered header/ciphertext/tag, truncation, oversized file, replay and multi-device failure tests; no plaintext on failure.
- [ ] Clear clean-origin/collision handling reuses E1 semantics, while never treating a test capability label as real authorization.
- [ ] Source review H0/M0, browser/fault tests, exact-head hosted CI, independent reviewer; separately approved physical Safari/VoiceOver and pilot.
- [ ] Non-sensitive logging, client-facing export instructions, recovery drill, secure artifact disposal and incident/key-loss runbook exist.

## Primary references

- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) — threat-first architecture, authenticated modes and key management
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html) — key lifecycle, custody and separation
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — indicative password-hardening/KDF baselines, *not* direct approval for backup-file key derivation
- [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — low-level primitives in secure contexts, not a complete safe archive system

**Next source step:** an *untrusted-envelope rejection contract* on synthetic fixtures only, with **no cryptographic implementation or real file import**, after design review. Project source and governance truth live here; operational secrets and user/client files must remain in their separate approved stores.
