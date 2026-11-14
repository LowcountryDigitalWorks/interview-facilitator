# Synthetic WebKit compatibility smoke (Linux runner; not physical Safari)

**Authority:** [Interview Facilitator roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), current accepted 1.3 offline-first source. **Status:** source-only QA candidate. No production or real-client data.

## Why this exists

Main CI exercises Chromium and the dormant recovery contracts. It does **not** establish behavior under the WebKit browser engine, which differs from Chromium on focus scrolling, layout, and IndexedDB. This narrowly scoped independent job provides earlier cross-engine evidence before a physical iOS/Safari/VoiceOver acceptance session.

## Test scope (synthetic only)

- **390 × 820:** Home defaults dark; appearance toggle to light, creation of a fictional interview, preservation of answer text and its actual persisted IndexedDB value. Starting at the answer control, a real `Tab` must focus the private question note. The focused note and sticky action dock must remain within the viewport with no overlap; then reload must preserve local answer and visual preference.
- **320 × 720:** Independent fictional dark-mode compact-screen session. Real forward `Tab` from answer to private note, backward `Shift+Tab` to answer, and forward `Tab` again must preserve focus order; note and sticky dock must fit the viewport, avoid overlap, and avoid horizontal page overflow. This is minimum-supported-width browser-engine QA, not a physical iPhone/iPad assertion.
- **1440 × 900:** Navigate a fictional interview to Review; PRIVATE outcome glance is **absent** from Presentation DOM, present/collapsible in Private Review, and absent again on returning to Presentation.
- **390 × 820, two isolated WebKit browser profiles:** Through real application controls, export a synthetic 1.3 single-session JSON from Private Review (not Presentation), import the downloaded file into a clean second profile, then reload and independently read the second profile's IndexedDB answer and private question note. Proves bounded manual file transfer only; the export does **not** preserve the full retained revision lineage or provide encryption/authenticated storage.

The runner uses an isolated Vite local preview and bundled Playwright WebKit on an Ubuntu-hosted GitHub Actions runner, with service workers blocked to avoid conflating PWA shell state with core application behavior. No hosted URL, backend, account, analytics, storage connector, real client details, PHI or CUI.

The existing default Chromium test suite and dormant 1.4/E1 read-back runner are **untouched**; new tests run only via `npx playwright test -c playwright.webkit-smoke.config.ts`. The job runs only on PRs affecting its own four paths and from the dedicated `feat/if-webkit-synthetic-smoke-` branch prefix. The workflow uses read-only GitHub contents permissions and existing pinned Node/checkout actions, no schedule, no credentials and no added package.

## How to interpret the result

| A green run supports | It does **not** support |
| --- | --- |
| The four synthetic tests passed under the Linux Playwright WebKit engine | Physical iPhone/iPad Safari, Home Screen PWA storage lifetime, iCloud/download behavior or VoiceOver |
| Local IndexedDB could persist this sample answer across a reload | Complete backup, no eviction, cross-device portability or real-session retention |
| A local, synthetic **single-session 1.3 JSON** export/import round-trip worked across separate Linux WebKit browser contexts, including a private note | Full revision-history archive recovery, device-to-device secure transfer, verified encryption, confidential backup policy, installed PWA restore, or physical Safari file handling |
| Current specific private glance DOM exclusion worked | Full client-facing confidentiality, consent/compliance, hostile-file restore or security certification |
| The 390px and 320px answer-to-private-note Tab paths work with viewport-safe note/dock geometry; the 320px case also checks reverse Tab and horizontal overflow | Exhaustive keyboard navigation, visual keyboard accessibility, VoiceOver, or focus behavior on actual Apple devices |

**Review L1 follow-up and source correction:** A 390px WebKit keyboard-Tab test initially exposed a real upper-viewport focus clip: the question note was at `top = -14px` while the dock remained visible at `top = 746px` ([red diagnostic run](https://github.com/LowcountryDigitalWorks/interview-facilitator/actions/runs/43522981581)). The bounded `src/main.ts` focus helper now checks upper, horizontal, lower-viewport, and sticky-dock clipping on focus and once on the next animation frame, then scrolls the active connected note to center if needed. The regression continues to require actual `Tab` navigation and both rectangles within the 390px viewport. A green synthetic result does not certify every keyboard sequence or viewport, physical Safari, VoiceOver, or an installed PWA.

**Acceptance gates:** successful exact-head standard and dedicated WebKit CI; independent author-/influence-excluded source review H0/M0; guarded source-only merge; exact merged-main CI; separate real-device manual usability and accessibility checks before any pilot. If the WebKit dependency installation is unsupported or flaky, **report failure**, do not silently skip or replace the job with Chromium.

**No source/license changes:** this work introduces no new npm dependency and does not select a repository license. Use only existing Playwright binaries delivered to CI. Repository is publicly visible, but verify actual runner billing entitlement before any additional usage; no PAYG/overage is authorized.
