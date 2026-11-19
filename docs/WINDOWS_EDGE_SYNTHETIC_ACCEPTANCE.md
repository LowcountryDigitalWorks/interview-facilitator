# Hosted Windows / branded Microsoft Edge synthetic smoke

**Authority:** Interview Facilitator product roadmap #5 and physical S2C matrix #37. Source baseline: accepted main 0c6c7e106f4e0bcddae2368bcb90aa63a38f4e62. This is a *test-only*, synthetic/public-safe addition; no production/PWA code change, source license, account configuration, host deployment, new dependency, or client data.

## Purpose and scope

LDW01 direct shell GitHub TCP 443 reachability failed Nov 18; a normal source checkout is not available to that test worker. Do not retry network routes, modify firewall/proxy or claim this hosted test repairs the workstation. A standard GitHub-hosted Windows Server 2025 VM has its own checkout and preinstalled Microsoft Edge. Playwright uses the real msedge channel, not the bundled Chromium binary. The standard public-repo hosted runner is a $0/included execution surface per GitHub public billing documentation; no larger runner, self-hosted runner or premium service is requested.

The dedicated test config executes just two fictional scenarios against Vite's existing production build on 127.0.0.1:4199:

1. **Windows Edge PWA shell in browser:** verify that the actual production Service Worker reaches activated/controlling state, turn the browser offline, reload from the cached shell, create an entirely fictional interview and independently inspect its persisted IndexedDB answer, then reload offline and inspect again. No server/API sync is involved.
2. **Windows Edge file handoff:** save fictional answer and private note, verify private export is absent in Presentation, enter Private Review, click actual JSON export, require a completed readable on-disk Windows download and valid schema 1.3 bytes, import that file via the normal UI into a second isolated Edge browser context, reload, independently verify the answer and private note remain in its IndexedDB.

Only the four new QA/docs/config/workflow paths trigger the extra job. The branch prefix gate limits it to the exact proposed test branch family. It runs with read-only contents permission, a GitHub-hosted ephemeral VM, and previously pinned official checkout/setup-node actions. No secrets, external host, analytics, telemetry, user browsing profile or real customer records. No browser installer, background schedule or recurrent bot.

## Interpretation

A PASS would show branded system Microsoft Edge on a **hosted Windows Server** can exercise those two specific synthetic local-first browser behaviors, including real browser download/restore and simulated offline service-worker shell. It **does not** prove the owner's Windows 11 LDW01 machine, a native installed Edge PWA, real airplane-mode or suspend/power loss, full revision-history retention, multi-tab conflicts, native Files destinations, iOS Safari/Home Screen separation, NVDA/VoiceOver, eviction, physical mobile update handling, approved secure backup, protected live sync, client pilot or production readiness. Never label this as physical W1/S2C-01–10 certification.

The dedicated workflow must finish successfully on the exact PR candidate, and separate author-/influence-excluded independent review plus normal PR CI must accept the source before guarded merge. A red test is evidence to investigate, not a reason to weaken its assertions or silently replace Edge with Chromium. The public branch's accepted source SHA and later final CI must be recorded in roadmap #5; all device acceptance cases remain NOT_RUN pending real-device proof.

## Run and cost boundaries

Local voluntary reproduction on an **already clean exact source** with already installed dependencies/Edge: run npm run build and npx playwright test -c playwright.windows-edge.config.ts. On GitHub, opening the specifically scoped PR triggers the isolated workflow automatically, in addition to ordinary CI. No customer/regulated data or secret-bearing artifact is ever uploaded.
