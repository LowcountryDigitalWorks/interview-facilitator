# S2B-0 — real SQLite transaction preflight, synthetic-only

**Status: source-only and synthetic-only, NOT D1 deployment, not provider acceptance, not an authenticated relay, and not client synchronization.** The live 1.3 installable PWA remains **LOCAL ONLY**. This proof closes one narrow technical uncertainty before protected S2B hosting/identity/recovery approval: do two independent SQLite connections actually honor a conditional server revision update, and do revision history and an operation receipt commit or roll back together?

## Authoritative boundary

- [Architecture #4](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/4), [product roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), [owner direction BO #753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753)
- [S2A-2 reviewed in-memory trial #145](https://github.com/LowcountryDigitalWorks/interview-facilitator/pull/145) is accepted; it was **not** a real DB transaction
- [Secure off-device recovery and keys #35](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/35), [ClientOps protected actor-to-engagement identity #105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105) are still separate owner/security gates

## What is implemented in this source-only milestone

`tests/fixtures/synthetic-sqlite-cas-schema-s2b.sql`: isolated test schema with four tables: test-fixture actor grants, current revision heads, immutable per-scope revision heads, and per-scope operation receipts. All keys include `tenant_id, client_id, engagement_id, session_id`; the receipt key also includes `operation_id`. Only fictional metadata is stored; it is NOT a D1 production migration or approved data model.

`tests/synthetic-sqlite-cas-s2b-preflight.test.ts`: eight real file-backed SQLite test cases using the **built-in Node.js 24 `node:sqlite` driver**, no third-party dependency, external request, persistent user data, or new account. Runs inside the existing `npm test` CI job. Every test creates an ephemeral temp directory with a database file and deletes it after closing connections.

1. Write and commit current head, retained revision, and receipt together; close/reopen a different SQLite connection; verify the same operation replays without duplicate records.
2. Inject a real `NOT NULL` constraint violation after partial writes; confirm SQL `ROLLBACK` leaves all three stores empty, then retry succeeds.
3. Use **two separate SQLite connections**: while one holds `BEGIN IMMEDIATE`, the second really reports `SQLITE_BUSY`; after the first commits an immediate child, the competing sibling attempt fails the conditional-CAS check and the winning revision/receipt stay intact.
4. Simulate lost response **after** SQL `COMMIT` and recheck exact operation receipt on retry.
5. Revoke test actor, assignment, or append permission, then reject even a previously valid receipt replay.
6. Deny cross-tenant/client/engagement/session attempts lacking exact scope grant; accept same metadata operation ID in an explicitly granted *separate* engagement without leaking or colliding across scopes.
7. Preserve immutable historical revision identifiers and reject a sibling/stale parent. A revision ID cannot be recycled after later heads advance.
8. Reject a forged deterministic operation hash and unsupported 1.4 schema without database changes.

### S2B-0.1 receipt integrity hardening (GM10 draft, independent review required)

The follow-on source-only candidate binds each test receipt to the exact `pack_digest` as well as the existing scoped revision/snapshot digest, and checks that a matching immutable revision still retains the original parent, pack digest and caller's expected predecessor. A new synthetic regression tests a legitimate child retry, forged pack, changed parent, wrong expected parent and a receipt orphaned from its immutable row. This is deliberately a **hardening of the existing S2B-0 fixture**, not another relay implementation. The S1 deterministic operation ID is not a signature and deliberately does not cover every metadata field, so a future protected server must validate all relevant committed context independently.

No real encrypted canonical content, trusted actor identity, hosted database, client sync, or production deployment is introduced. This text records the candidate's intended behavior, not a CI or independent acceptance claim. Exact-head CI and author-independent review are still required.

**Important precision:** `node:sqlite` uses an actual single-machine SQLite file with transactions, but does not exercise Cloudflare D1, RPC, Workers, multiple datacenters, Access, client tokens, remote signed acknowledgments or provider-level distributed consistency. This is a local test of SQLite's conditional SQL and transaction mechanics, NOT a tested D1 Worker binding. The test function receives a **claimed actor ID**; a malicious caller could impersonate it. Consequently test grants prove only fixture-scope SQL behavior; the function MUST NEVER be exposed as an HTTP endpoint or considered authorization.

No private notes, customer labels, PHI, binary attachments, full canonical interview snapshot, encryption keys, audit logs or credentials are stored in this test database. The cryptographic operation hash is an equality fingerprint **not a signature**. A successful SQL COMMIT is *not* a remotely verified end-to-end backup. Hardware loss, browser eviction, offline mobile origin migrations, and off-device restoration remain separate risk tests. The test uses SQLite DELETE rollback journal and synchronous FULL, **not WAL**; provider journal settings and durability must be separately verified. SQLite's [isolation](https://www.sqlite.org/isolation.html), [WAL tradeoffs/2026 WAL-reset fix](https://www.sqlite.org/wal.html), [Node 24 SQLite](https://nodejs.org/api/sqlite.html) and [Cloudflare D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) documentation are the reference points.

## Read-only Cloudflare account discovery — NOT an entitlement or provider selection

The authenticated LDW Cloudflare account (not client-owned accounts) was inspected **READ ONLY** on Nov 14, 2026. It currently lists **3 D1 databases and 8 Worker scripts**, with no resource specifically dedicated to Interview Facilitator. Those resources support existing LDW applications and must **not** be repurposed or mutated. The account subscriptions request returned HTTP 403; this did **not** verify plan, eligible Free quotas, Workers/Access entitlements, overage behavior or cost cap. Consequently **do not create** a D1 database, Worker route, Access app, binding, token, tenant or customer data store based on this discovery. Provider pricing/public docs are preliminary, not account-specific proof.

## S2B go/no-go contract

**GO only after owner/security and relevant ClientOps approval**, all supported by authoritative private records, for:

- A dedicated, identified, approved LDW-private host + existing-$0 entitlement with explicit spend/overage behavior and quotas; preserve existing Workers/D1 sites
- A trusted authentication provider returning an authenticated actor independent of client input, then per-request server-owned actor↔tenant↔client↔engagement↔session authorization, revocation and private read/write restrictions (#105 / BO #175)
- Private canonical session byte validation, bounded payload sizes, pack/schema/digest checks and no public logs/tracking of client content
- Actual provider-level atomic conditional update, retained immutable versioned content and exact scoped operation receipt, plus race/lost-reply/outage/revocation/restart tests
- Transport confidentiality, encrypted-at-rest/key custody, retention/deletion, private review, off-device encrypted backup/recovery and safe rollback (#35); a sync receipt alone is not a backup
- A synthetic-only two-device offline/reconnect proof on real endpoints, accepted physical Windows and Safari/iOS tests, keyboard/VoiceOver/storage/quota trials, independent security review, then owner pilot authorization before any client content

**Decision recommendation:** Keep the offline-first PWA as the primary app, and do **not** introduce a separate native installer or real sync service until the above gates are evidenced. A D1-style relay remains one candidate, not approved implementation. The next useful non-provider step is an **owner/security decision packet** and evidence collection for protected identity + hosting + recovery, rather than proliferating synthetic simulators.

**Source acceptance:** branch PR with exact-head hosted CI, independent author-/influence-excluded H0/M0, expected-head guarded merge, and independently confirmed exact merged-main event=`push` CI terminal success. All activity is within existing $0 source/CI allowances.
