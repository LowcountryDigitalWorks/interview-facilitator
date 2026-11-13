# Portable restore preflight dry-run (M4 / E0)

**Issue:** [#123](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/123) portable multi-revision archive contract  
**Module:** `src/portable-restore-plan.ts`  
**Not:** import UI, IndexedDB writes, encrypted backup, Drive/OAuth, or production restore.

## Purpose

`planFreshOriginPortableRestoreDryRun` accepts an **untrusted** portable revision archive JSON string, validates it with `validatePortableRevisionArchiveJson`, then validates each retained `record` with `validateSemanticSessionRecord` (1.3 authority). It returns a **read-only** preflight plan describing what *could* be imported later—never performing restore.

## Trust boundaries

| Mechanism | What it proves | What it does **not** prove |
|-----------|----------------|----------------------------|
| Archive envelope + checksum | Accidental corruption of canonical JSON | Trusted origin, authorship, or adversarial tamper resistance |
| 1.3 semantic validation | Record shape, pack pin, bounded session graph | Complete autosave history, off-device protection, confidentiality |
| Lineage status | Declared parent graph inside the archive | Local IndexedDB state or destination collision outcome |

An adversary can edit semantically valid retained records and call `createPortableRevisionArchive` to recompute the unkeyed digest. Preflight may still return `preflight-complete-head-validated` for that recomputed envelope. That outcome is **not** trusted-source attestation and **not** tamper-authentication.

Checksum mismatch (mutated bytes with an **unchanged** digest field) is rejected as accidental corruption only.

## Verdicts

- **`preflight-complete-head-validated`** — `lineageStatus === 'complete-to-root'` and all retained records passed 1.3 validation; `headImportFeasible: true` (still **no** automatic import).
- **`preflight-incomplete-lineage`** — Archive structurally valid but ancestry incomplete/unlinked; `headImportFeasible: false`.
- Failures throw before a plan is returned (malformed JSON, wrong scoped session/head, semantic mismatch, mixed packs, forged checksum, etc.).

## Owner-approved next steps (out of scope here)

1. Destination / collision policy for an empty or existing fresh-origin profile.  
2. Atomic transactional IndexedDB import with rollback.  
3. Operator review separate from this synthetic dry-run.

## Related contracts

- `src/portable-revision-archive.ts` — archive envelope (#123)  
- `src/local-revision-continuity.ts` — retained **local** snapshot audit (not portable import)  
- `src/semantic-session.ts` — `validateSemanticSessionRecord` authority
