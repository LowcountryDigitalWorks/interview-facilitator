# Synthetic WebKit compatibility smoke (Linux runner; not physical Safari)

**Authority:** [Interview Facilitator roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), current accepted 1.3 offline-first source. **Status:** source-only QA candidate. No production or real-client data.

## Why this exists

Main CI exercises Chromium and the dormant recovery contracts. It does **not** establish behavior under the WebKit browser engine, which differs from Chromium on focus scrolling, layout, and IndexedDB. This narrowly scoped independent job provides earlier cross-engine evidence before a physical iOS/Safari/VoiceOver acceptance session.

## Test scope (synthetic only)

- **390 × 820:** Home defaults dark; appearance toggle to light, creation of a fictional interview, preservation of answer text and its actual persisted IndexedDB value. Starting at the answer control, a real `Tab` must focus the private question note. The focused note and sticky action dock must remain within the viewport with no overlap; then reload must preserve local answer and visual preference.
- **1440 × 900:** Navigate a fictional interview to Review; PRIVATE outcome glance is **absent** from Presentation DOM, present/collapsible in Private Review, and absent again on returning to Presentation.

The runner uses an isolated Vite local preview and bundled Playwright WebKit on an Ubuntu-hosted GitHub Actions runner, with service workers blocked to avoid conflating PWA shell state with core application behavior. No hosted URL, backend, account, analytics, storage connector, real client details, PHI or CUI.

The existing default Chromium test suite and dormant 1.4/E1 read-back runner are **untouched**; new tests run only via `npx playwright test -c playwright.webkit-smoke.config.ts`. The job runs only on PRs affecting its own four paths and from the dedicated `feat/if-webkit-synthetic-smoke-` branch prefix. The workflow uses read-only GitHub contents permissions and existing pinned Node/checkout actions, no schedule, no credentials and no added package.

## How to interpret the result

| A green run supports | It does **not** support |
| --- | --- |
| These two synthetic tests passed under the Linux Playwright WebKit engine | Physical iPhone/iPad Safari, Home Screen PWA storage lifetime, iCloud/download behavior or VoiceOver |
| Local IndexedDB could persist this sample answer across a reload | Complete backup, no eviction, cross-device portability or real-session retention |
| Current specific private glance DOM exclusion worked | Full client-facing confidentiality, consent/compliance, hostile-file restore or security certification |
| The 390px answer-to-private-note Tab path works and both focused note and sticky dock fit the viewport without overlap | Exhaustive keyboard navigation, visual keyboard accessibility, VoiceOver, or focus behavior on actual Apple devices |

**Review L1 follow-up and source correction:** A 390px WebKit keyboard-Tab test initially exposed a real upper-viewport focus clip: the question note was at `top = -14px` while the dock remained visible at `top = 746px` ([red diagnostic run](https://github.com/LowcountryDigitalWorks/interview-facilitator/actions/runs/43522981581)). The bounded `src/main.ts` focus helper now checks upper, horizontal, lower-viewport, and sticky-dock clipping on focus and once on the next animation frame, then scrolls the active connected note to center if needed. The regression continues to require actual `Tab` navigation and both rectangles within the 390px viewport. A green synthetic result does not certify every keyboard sequence or viewport, physical Safari, VoiceOver, or an installed PWA.

**Acceptance gates:** successful exact-head standard and dedicated WebKit CI; independent author-/influence-excluded source review H0/M0; guarded source-only merge; exact merged-main CI; separate real-device manual usability and accessibility checks before any pilot. If the WebKit dependency installation is unsupported or flaky, **report failure**, do not silently skip or replace the job with Chromium.

**No source/license changes:** this work introduces no new npm dependency and does not select a repository license. Use only existing Playwright binaries delivered to CI. Repository is publicly visible, but verify actual runner billing entitlement before any additional usage; no PAYG/overage is authorized.
