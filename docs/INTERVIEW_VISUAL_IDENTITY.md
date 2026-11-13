# Interview Visual Identity — Iris / Ember · Clarity Glass

Product-specific **proposed** theme for Interview Facilitator (not corporate LDW brand). Supersedes the historical light-only Tidal draft in PR #124 for **new** implementation; #124 remains untouched reference only.

## Principles

- **Dark default** on clean install, independent of OS `prefers-color-scheme`.
- **Explicit Appearance** control (Dark / Light) on Home, New interview, Interview, and Review (including Presentation for cosmetic toggle only).
- **Glass** limited to functional chrome: app header and sticky action dock, with `prefers-reduced-transparency` and `forced-colors` opaque fallbacks.
- **Opaque** content: questions, inputs, rails, review sections, evidence lens pills, dialogs.
- No session JSON, IndexedDB, provider, or pack schema changes.

## Tokens

| Role | Dark | Light |
|------|------|-------|
| Canvas | `#11121D` | `#F6F4FB` |
| Panel | `#1D2030` | `#FFFFFF` |
| Elevated | `#29293B` | `#FFFFFF` |
| Text | `#F5F1FB` | `#282438` |
| Muted | `#B9BDD1` | `#56546A` |
| Accent (iris) | `#B8A0FF` | `#60439C` |
| Ember / attention | `#F7BE97` | `#9A4D18` |

Implementation uses CSS custom properties on `html[data-appearance]` in `src/styles.css`. PWA `theme-color` and `color-scheme` update with the toggle.

## Persistence

- Key: `ldw.interview-facilitator.appearance.v1` in `localStorage` (visual preference only).
- Read/write errors fall back to default dark plus the current in-memory choice for the session.
- Toggle does **not** re-render interview DOM (delegated click handler; no `render()` on theme change).

## CI

Browser contract: `tests/browser/appearance-contract.pw.ts` (included in default `playwright.config.ts` `testMatch`).

## Acceptance

Owner visual approval and real Safari/VoiceOver passes are **separate gates** from source CI. No production customer deploy by this workstream.
