# Question focus mode (private interview, desktop)

Status: **DRAFT** feature — human-controlled layout affordance on the live 1.3 offline interview shell.

## Behavior

- **Default:** unchanged three-column cockpit (coverage · question stage · context).
- **Desktop (`min-width: 981px`):** optional header control **Focus on question** / **Show full workspace** (`aria-pressed`).
- **Toggle is class/DOM-state only** — no full re-render of the answer block; caret, unsaved edits, autosave cadence, and revision lineage stay on the live controls.
- **Rails:** visually removed and `inert` while focused so they are not tabbable; restored on exit.
- **Excluded:** Presentation view, client-safe Read-back/review surfaces, home/prepare.
- **Mobile/tablet (`max-width: 980px`):** control hidden; existing mobile drawer + focus trap unchanged.

## State boundary

`questionFocusMode` is **ephemeral** (module memory). No IndexedDB, canonical JSON, provider, or session field writes.

## Styling

`src/focus-mode.css` imports **after** `src/styles.css`. Does not edit `styles.css` (preserves draft PR #124 integration path).

## Verification

Appended cases in `tests/browser/acceptance.pw.ts` — synthetic sessions only; not iOS/VoiceOver certification.
