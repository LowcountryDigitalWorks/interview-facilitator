# Private outcome glance — PRIVATE Review UI (M3B)

`renderPrivateOutcomeGlanceHtml` surfaces accepted M3A projection data in **PRIVATE Review only**. Markup is omitted entirely in Presentation mode (`presenting ? ''` before `innerHTML`).

- Collapsible `<details>` with keyboard-reachable `<summary>`; opaque Fieldnotes panels via `private-outcome-glance.css`.
- All prompts, display values, provenance strings, notice, and suggested follow-up pass through HTML escaping before interpolation.
- `visible: false` rows are suppressed (unknown pack mappings never render raw pack IDs).
- Toggling the glance does not write session JSON, rotate revisions, or trigger autosave.

See `docs/PRIVATE_OUTCOME_GLANCE.md` for projection semantics and `src/private-outcome-glance.ts` for layout maps.
