# Private Outcome Glance (M3A)

Pure-domain, side-effect-free **PRIVATE** projection for human interviewer synthesis. **No UI wiring** in this contract.

## Boundary

- **In scope:** deterministic glance from a validated `SemanticInterviewSession` with pinned `packSnapshot`, using existing `relevanceMap` / coverage bucket rules / evidence semantics.
- **Out of scope:** client Read-back, Presentation, public export, CRM tasks, email, provider writes, AI, consent/legal verification claims, or automatic commitments.
- **Output may include answer values** from the private session; consumers must treat values as classified evidence, not authenticated client events.

## API

- `projectPrivateOutcomeGlance(raw)` — validates then projects.
- `projectPrivateOutcomeGlanceFromSession(session)` — pure projection from an already-validated session (read-only; does not mutate input).

Schema: `ldw.private-outcome-glance.v1`

Sections:

| Section | Role |
|---------|------|
| `outcome` | Pack-mapped primary outcome questions |
| `dependencies` | Pack-mapped dependencies / constraints |
| `unknowns` | Pending relevance, open coverage, needs-confirmation, tentative/stale evidence |
| `suggestedConversationStep` | Human conversation prompt grounded in unknowns — **not** an external task |

## Pack maps (five live 1.3 packs)

Layouts are keyed by pinned `packSnapshot.packId` in `LIVE_PINNED_PACK_GLANCE_LAYOUT` (`src/private-outcome-glance.ts`). Unknown historic pack IDs fall back to empty maps; unmapped open evidence may still appear under `unknowns`.

Inactive / irrelevant conditional questions are omitted. Internal `note` fields are not exported.

## Persistence / runtime

No IndexedDB, DOM, network, or `main.ts` integration in this delivery. Preference and theme work remain separate (#127).

## Tests

`tests/private-outcome-glance.test.ts` — all live packs, conditionals, provenance classes, hostile strings, determinism, and non-mutation.
