# Synthetic portable restore (E1 test harness only)

**Status:** Internal source proof for [#35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35). **Not** a user-facing Restore control, **not** a customer import path, **not** off-device confidentiality, and **not** archive authentication.

## Scope

`importSyntheticPortableArchiveFreshOrigin` performs a **synthetic-only**, **test-token-gated** fresh-origin import of a bounded [portable revision archive](./PORTABLE_RESTORE_PLAN.md) that:

1. Passes `planFreshOriginPortableRestoreDryRun` with `complete-to-root` lineage (missing ancestors are **rejected**, not partially imported).
2. Validates every retained 1.3 semantic record and requires each `clientLabel` to match the synthetic prefix guard (`/^synthetic(?:\s|[-_])/i`).
3. Uses one **strict-durability** IndexedDB readwrite transaction across `sessions` and `revision-history`, refusing when session row or revision-history prefix already exists.
4. Writes the archive **head** to `sessions` and **non-head** retained revisions to `revision-history` with `revisionHistoryKey(sessionId, revisionId)`.
5. Verifies both stores after `oncomplete`; a readback failure after commit returns `committed-unverified`, not a silent success.

Unkeyed archive SHA-256 detects accidental envelope corruption only. An adversary can recompute the digest after edits; that does **not** prove trusted origin or tamper-evidence.

## Trust limits

| Claim | Supported by E1? |
|--------|------------------|
| Atomic fresh-origin write into empty local slot | Yes (synthetic harness, strict tx) |
| Complete retained chain to declared root | Yes (preflight + complete-to-root) |
| All historical autosaves ever written | **No** |
| Encrypted / authenticated / off-device backup | **No** |
| Real client or pilot authorization | **No** |

## API guard

Callers must pass `testOnlyCapability: 'ldw.synthetic-portable-restore-test-only.v1'`. The live application shell does not export or wire this path.

## Related modules

- `src/portable-revision-archive.ts` — archive envelope (#123)
- `src/portable-restore-plan.ts` — read-only preflight dry-run (#128 / M4 E0)
- `src/storage.ts` — production autosave/history writers (unchanged)
