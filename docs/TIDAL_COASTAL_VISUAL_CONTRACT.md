# Tidal coastal visual contract (GM08 source-only draft)

Status: **SOURCE_ONLY / DRAFT** — human-led offline Interview Facilitator chrome refresh. Not production deployment, not iOS/VoiceOver certification.

## Direction

LDW premium **Tidal coastal liquid-glass-ish** language: Navy `#102A3A`, Teal `#2F766F`, Oyster `#F3EFE6`, Soft White `#F7F8F6`. Translucent/frosted treatment is **limited to functional chrome** (top header, sticky action dock). **Content surfaces stay opaque** (cards, forms, rails, review panels) for readability and privacy presentation.

## Typography

- **Shipped stack:** system UI sans (`ui-sans-serif`, `Segoe UI`, etc.) — no bundled webfonts, **no CDN**.
- **Future gate:** `Manrope` may be self-hosted in a separate change after font files are in-repo and licensing is recorded. Website PR visual direction is **not** copied wholesale.

## Accessibility

- Minimum **44px** touch targets on primary chrome controls (unchanged).
- Visible **focus rings** (`#e8a51c`, 3px) preserved.
- `env(safe-area-inset-*)` on sticky dock.
- `@media (prefers-reduced-motion: reduce)` disables non-essential transitions.
- `@media (prefers-reduced-transparency: reduce)` and `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` force **opaque** chrome backgrounds.
- `@media (forced-colors: active)` keeps header/dock readable with system colors.

## Synthetic verification

Playwright geometry contract: `tests/browser/tidal-visual-contract.pw.ts` at viewports **320, 360, 375, 390, 768, 1440** — no overlap with portable revision archive PR #123.

### Before → after (synthetic observations)

| Area | Before (`48abdbd`) | After (GM08 draft) |
|------|-------------------|---------------------|
| Body | Flat `#F7F8F6` | Coastal mist gradient + soft-white fallback |
| Header | Solid navy | Opaque navy/teal gradient; optional backdrop blur when `prefers-reduced-transparency: no-preference` + `backdrop-filter` support |
| Hero card | White→oyster gradient | Opaque white + light shadow (content readability) |
| Action dock | Always-on 8px blur | Opaque white default; blur only under same transparency/support gates |
| Type | `Inter` first in stack | System UI stack (Manrope self-host gate documented) |

**Residual (merge gate):** wire `**/tidal-visual-contract.pw.ts` into `playwright.config.ts` `testMatch` so default `npm run test:browser` / hosted CI runs the GM08 floor (local verification used ephemeral config; 8/8 pass). **`prefers-reduced-transparency: reduce`** is implemented in CSS; Playwright 1.64 has no `emulateMedia` for it — forced-colors path is automated instead.
