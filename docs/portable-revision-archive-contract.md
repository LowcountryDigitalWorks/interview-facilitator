# Portable multi-revision archive contract â€” synthetic-only phase 1

This source-only contract defines versioned JSON for exporting and validating a bounded set of already-retained Interview Facilitator 1.3 revisions. It does not add UI, IndexedDB wiring, file handling, import/restore, encryption, authentication, off-device storage, or a complete edit history.

## Envelope

`ldw-interview-revision-archive` version `1` contains one session ID, one declared head revision ID, canonical creation time, a derived lineage status, and up to 200 retained revisions. Each row carries its revision ID, parent ID, canonical UTC `updatedAt`, and the unchanged 1.3 record. Rows are serialized in stable timestamp/revision-ID order. A SHA-256 checksum covers canonical JSON to detect accidental corruption; it is unkeyed and can be recomputed, so it is not authentication or tamper protection.

Validation rejects extra/missing fields, unsupported schema versions, malformed/noncanonical JSON, oversized data, invalid session/revision identity, conflicting duplicate IDs, cycles, reverse-time parent edges, wrong/missing head, corrupt checksum, and inconsistent lineage declarations. Missing parent ancestors and unlinked rows remain explicitly classified as incomplete/unlinked; they are never synthesized from the current session.

`complete-to-root` means only that the included head chain reaches a record whose parent is null. It does not prove ordinary autosaves were retained, so it is not a claim of complete historical revisions. The existing 1.3 semantic-session validator remains required before an application accepts any archived record. This contract performs no application restore, IndexedDB mutation, or current 1.3 JSON import behavior change.

## Security and recovery limits

The archive is plaintext JSON unless a future separately reviewed design adds encryption/key management. The checksum is not keyed. Anyone able to edit the archive can recompute it. This phase does not authenticate its source, protect confidentiality, prove origin, provide off-device backup, or guarantee recovery. Synthetic fixtures only; never place client data or secrets in repository tests.

