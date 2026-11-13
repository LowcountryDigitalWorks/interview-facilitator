# E2A — proposed fail-closed encrypted portable envelope contract (NO CRYPTO IMPLEMENTED)

**Status:** PROPOSED / SOURCE-ONLY / SYNTHETIC-ONLY; read with [the E2A threat model](./PORTABLE_ENCRYPTED_ARCHIVE_THREAT_MODEL_E2A.md), [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35) and the accepted [E1 transaction proof](./SYNTHETIC_PORTABLE_RESTORE.md). This document describes future parser requirements, **not a valid export format**. No encryption, KDF, keys, upload, file download, provider sync, client import or Restore control is added.

## Pipeline and non-negotiable boundaries

A future candidate must separate five stages, with no database writes before the last:

1. **Pre-parse limits:** impose a reviewed hard file-size cap and bounded envelope/header/parser limits *before* JSON/base64/ciphertext allocation; reject abnormal Unicode, duplicate JSON keys, malformed/trailing bytes and unsupported format/magic/version.
2. **Format and crypto policy:** allowlist one independently approved scheme/version and approved parameter range; reject ambiguous coercion, unknown key-wrap schemes, low or excessive KDF cost, weak/empty salt, malformed nonce/tag, unbound metadata, and oversized ciphertext.
3. **Authenticated decryption:** verify authenticated ciphertext plus all security-critical header fields as associated data; fail without exposing plaintext. Never reuse an AES-GCM nonce with the same content-encryption key. Determine whether the DEK is unique per exported archive and how any wrapped key is created/reused **before code**.
4. **Canonical untrusted record validation:** only after authentication, validate schema/pack digest, session and head IDs, entire retained revision envelope, lineage, current semantic 1.3 records, exact binding to declared archive metadata. Reject mixed records, incomplete roots, unknown major version or invalid history. Authenticated ciphertext is not publisher identity or client consent.
5. **Operator and transaction gate:** real user approval, target origin/tenant/session, replacement policy, collision check and visible confirmation precede any IDB change. Synthetic-only tests may reuse E1 strict transaction / readback semantics. A real customer Restore UI is a **separate** authorized feature.

## Proposed envelope metadata properties (design candidates, **not schema-approved**)

| Concept | Requirement / unresolved decision |
| --- | --- |
| Format family and major version | Constant, exact typed value; any unknown major version rejects, no fallback to plaintext |
| Crypto suite ID | Exact allowlisted authenticated mode and key size; AES-256-GCM is a candidate, not yet selected or certified |
| Key-wrap / KDF descriptor | Exact type, salt, parameters and secure bounds; design decision pending random secret vs passphrase and Argon2id/PBKDF2 |
| AEAD nonce and authentication tag | Per-ciphertext uniqueness and strict encoding/length; determine nonce construction and DEK lifecycle with security review |
| Header/body encoding and byte count | Bounded length, canonical encoding, no oversized allocation, decode errors fail closed |
| Authenticated metadata / AAD | Bind security-critical version, suite/KDF/parameters, nonce, content type, and relevant plaintext scope to ciphertext; no unattested mutable header fields |
| Cleartext metadata | Default to *no client name, email, session ID, pack label, note, or other private data*; the concrete minimum header set requires privacy review |
| Plaintext payload | Entire current 1.3 portable archive including all included retained private records; this is **not** completeness of ever-written autosaves |
| Integrity/provenance | AEAD tag can detect malicious changes to protected bytes under the key; it does **not** authenticate a named person, timestamp accuracy or client authorization |
| Recovery / retention | Key loss or deletion can make archive permanently unrecoverable; no undocumented backdoor, local key escrow or cloud sync |

**Do not serialize an artificial v0 example and accidentally accept it as a valid encrypted archive.** Implementations must use an explicitly reviewed version, and format docs must describe exact bytes used as authenticated associated data (not just JSON object properties).

## Mandatory negative tests for a future parser (all synthetic)

| Class | Rejection or outcome |
| --- | --- |
| Header/structure | null/array/number/duplicate keys, unrecognized magic/version/algorithm, extra unrecognized security fields, noncanonical or malformed encoding |
| Resource exhaustion | file/header/ciphertext too large, excessive KDF memory/time/iterations, huge nested JSON/array, pathological base64 |
| Cryptographic tamper | bitflip in ciphertext, tag, nonce, KDF descriptor, version or AAD-bound metadata => authenticated rejection, **no partial plaintext** |
| Credential failure | wrong recovery material => indistinguishable privacy-safe error; no plaintext, no destination mutation |
| Nonce or key handling | nonce/key reuse attempts and unsupported key lifecycle fail explicit policy tests |
| Semantic data | canonical 1.3 archive invalid, mixed session/pack, unknown digest, missing parent, duplicate revision, cycle, stale hidden/inferred evidence misrepresented |
| Import state | already-present session, orphan history, competing tab/transaction, abort, quota failure, post-commit readback error => E1-equivalent truthful outcomes |
| Destination/recovery | missing file, missing recovery secret, missing approved target, wrong tenant or legal hold => no automatically attempted restore |
| Privacy | no client strings in header or logs; no private data in generated screenshots, CI artifacts or error reports |
| Device | browser storage permission/strict durability/crypto capability failure, Safari/mobile memory pressure, offline use, keyboard/AT and file input/export behavior |

## Acceptance sequence / deployment holds

- **E2A documentation acceptance:** independent reviewer H0/M0 on this design, with open decisions clearly labeled. Docs-only PR/CI does **not** imply a deployed security control.
- **E2B decision:** owner and security authority pick custody, KDF or key source, destination/retention, archival scope, operating threat assumptions and physical-device targets. Record accepted versioned security ADR; never bury decisions in a default.
- **E2C synthetic implementation:** one new PR, no real client data, deterministic standards-based test vectors, audited primitives, fail-closed malformed inputs, no remote provider, no built-in secrets; independent source/security review and exact merged CI.
- **E2D governed customer UX:** explicitly authorized export/import, human-readable warnings, physical Safari/VoiceOver and recovery drill, destination consent, incident response and deletion semantics. No release/pilot until approvals.

**Implementation restriction:** DO NOT introduce executable cryptography, CryptoKey persistence, third-party packages, OAuth, Drive folder access, real Restore UI or customer records merely by accepting this E2A document. The offline-first interview continues to work without the future feature.
