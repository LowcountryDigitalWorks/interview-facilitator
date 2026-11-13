# Fieldnotes synthetic visual-review packet

This bounded, $0/included source-only proof generates a **12-image static screenshot packet** from a real local Playwright/Vite render of the Interview Facilitator. It does not deploy the app.

| | Dark default | Optional light |
|---|---|---|
| Mobile (390×820) | Home, Interview, Private Review | Home, Interview, Private Review |
| Desktop (1440×900) | Home, Interview, Private Review | Home, Interview, Private Review |

Screenshots contain exclusively fictional synthetic labels and answers. No customer records, tokens, provider data, workspace URLs, PHI, CUI, or real LDW commercial data are used.

## How to inspect

Find the successful **Synthetic Fieldnotes visual review packet** GitHub Actions run attached to this source PR. Under **Artifacts**, download the artifact named fieldnotes-synthetic-visual-review, extract it, and open the PNG files or README. Artifacts expire after 7 days. A verified successful run and artifact must exist before anyone claims a preview is available.

The screenshots offer a static look at layout and color. They do **not** replace owner visual approval, interactive UX acceptance, real iOS/Safari/VoiceOver proof, governed offline/private recovery, or production/client-pilot authorization.

The workflow triggers only when these specific artifact sources change on a review branch beginning feat/if-synthetic-visual-review. It requests read-only repository permissions and publishes no site, new host or domain. It uses existing Node 24, Vite, Playwright and official SHA-pinned GitHub Actions. No recurring schedule, analytics or dependencies are introduced.

This PR does not change the live application source, session schema, storage, packs, ClientOps/Owner Console integrations or production configuration.
