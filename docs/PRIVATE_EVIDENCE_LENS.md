# Private Evidence Lens (Phase C v1)

**DRAFT / SOURCE ONLY** — PRIVATE Review human affordance for existing `SemanticAnswerState` provenance fields.

## Visibility

- Shown only in **private** Read-back review rows (`!presentation`).
- Never in Presentation view, client-safe read-back projection, or exports.

## Semantics

Neutral labels only; no legal verification, consent, or completion claims. Confirmation metadata is compared for staleness wording only, never promoted to “verified”.

## Files

- `src/private-evidence-lens.ts` — pure projection
- `src/evidence-lens.css` — opaque badges (Tidal-adjacent tokens, independent of PR #124)

No canonical schema, IDB, or session writes.
