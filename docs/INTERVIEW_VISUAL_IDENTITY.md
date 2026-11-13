# Interview Visual Identity — Fieldnotes · Ember / Glacier

Product-specific **proposed** theme for Interview Facilitator (not corporate LDW brand, **not** G.A.S. spectral-lilac). Distinct from website Tidal and from G.A.S. midnight/lilac. Historical light-only Tidal draft PR #124 remains superseded reference only (untouched).

## Principles

- **Dark default** on clean install, independent of OS `prefers-color-scheme`.
- **Explicit Appearance** control (Dark / Light) on Home, New interview, Interview, and Review (including Presentation for cosmetic toggle only).
- **Glass** limited to functional chrome: app header and sticky action dock, with `prefers-reduced-transparency` and `forced-colors` opaque fallbacks.
- **Opaque** content: questions, inputs, rails, review sections, evidence lens pills, dialogs.
- No session JSON, IndexedDB, provider, or pack schema changes.

## Tokens

| Role | Dark | Light |
|------|------|-------|
| Canvas | `#111820` | `#F8F5F0` |
| Panel | `#1E2730` | `#FFFFFF` |
| Elevated | `#2B3741` | `#FFFFFF` |
| Text | `#F3F6F6` | `#27313B` |
| Muted | `#BBC7CE` | `#5D6570` |
| Primary (ember / copper) | `#F4C27C` on `#111820` | `#914B20` on `#FFFFFF` |
| Secondary glacier / coral | `#8CBDF5` · `#FF9C85` | `#275C86` |

Implementation uses CSS custom properties on `html[data-appearance]` in `src/styles.css`. PWA `theme-color` and `color-scheme` update with the toggle.

## Persistence

- Key: `ldw.interview-facilitator.appearance.v1` in `localStorage` (visual preference only).
- Read/write errors fall back to default dark plus the current in-memory choice for the session.
- Toggle does **not** re-render interview DOM (delegated click handler; no `render()` on theme change).

## CI

Browser contract: `tests/browser/appearance-contract.pw.ts` (included in default `playwright.config.ts` `testMatch`).

## Acceptance

Owner visual approval and real Safari/VoiceOver passes are **separate gates** from source CI. No production customer deploy by this workstream.
