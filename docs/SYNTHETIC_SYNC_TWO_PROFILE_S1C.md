# S1C — two isolated browser profiles, offline edit, synthetic reconnect

**Scope: source-only and test-only. NOT a client synchronization service, deployed PWA feature, authenticated relay, or encrypted backup.**

Authority: [architecture #4](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4#issuecomment-6872727322), [roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5#issuecomment-6872731773), [S1 source planner PR #141](https://github.com/LowcountryDigitalWorks/interview-facilitator/pull/141) and [S1B native offline outbox PR #142](https://github.com/LowcountryDigitalWorks/interview-facilitator/pull/142).

## What this synthetic rehearsal proves

The existing dormant Vite-dev browser test creates **two entirely distinct Chromium BrowserContext profiles**, each with its own separate origin-specific IndexedDB data. It seeds the same fictional 1.3 interview as an initial revision in both profiles. With **both contexts set offline**, each records a different child revision and confirms its own native IndexedDB current head, complete retained synthetic local history and two pending outbox operations. No queue metadata includes the fictional private interview notes.

The test then reconnects one context; **only a JS variable in the Playwright test** represents an already-present remote head. It checks that the desktop's immediate child revision is an eligible synthetic `offer-local` and changes that mock remote variable. It deliberately drops the supposed receipt and proves that the desktop's pending operation is **not** removed. When the other context reconnects it has a sibling revision from the same parent; the planner returns `preserve-conflict` and retains both revision heads. No last-write-wins, automatic answer merge, remote snapshot overwrite, device-to-device content sharing or provider request is made.

Finally, an explicit **test-only** mock receipt removes only the acknowledged desktop pending operation atomically, preserves all local source history and produces no duplicate receipt or resurrected pending item on replay. The mobile context retains its own unchanged pending work. Both ephemeral browser contexts are closed after the test.

## Trust and release limits

- A `BrowserContext` isolates browser storage, but it is not a physical Windows install, Safari Home Screen app, phone, multi-user authorization boundary or power-loss test. The Vite dev harness is not an offline production service-worker test; offline is only after the required modules have been loaded.
- The mock head exchange is performed by **test code**, not by a network endpoint. No cloud storage, per-engagement access control, login, encryption or actual durable remote acknowledgment is implemented or verified.
- Native IndexedDB `complete` does not imply fsync guarantees after sudden power loss or resistance to storage eviction. Real recovery policy remains governed by #35.
- A device that stays offline cannot know about changes made elsewhere. Real convergence requires both devices to connect to a separately authorized secure service and pass tenant/engagement identity, storage, security and approval gates #105/#35.
- Human conflict resolution UI, attachment blobs, 1.4 lifecycle activation, and Tauri desktop native installers are **not** in this source-only slice. Do not display user-facing `SYNCED` or market this proof as cross-device sync.
- All fixture data are fictional. Zero new providers, accounts, tokens, client/private facts, server SDKs, external network writes, new dependencies or costs.

## Acceptance

The single new browser case must pass inside the already-established **dormant** Chromium harness in hosted CI, alongside all existing tests. New S1C source is accepted only through independent author-excluded exact-head H0/M0 source review, collision-free guarded merge and exact merged-main PUSH CI terminal success. The next phase is a *protected* synthetic relay pilot only after owner/security/classification/hosting approvals; no live client data or automatic background sync is authorized here.
