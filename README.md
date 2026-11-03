# Interview Facilitator

An offline-first, human-led interview/discovery cockpit from Lowcountry Digital Works.

The facilitator is designed to keep a real conversation natural while quietly tracking question coverage, known context, unresolved items, notes, and deterministic records. It is **not** a CRM, public intake form, chatbot, recorder, or autonomous qualification system.

## Current vertical slice

- TypeScript + Vite, no application framework
- installable PWA shell
- local IndexedDB session persistence
- one synthetic generic discovery pack
- deterministic conditional question relevance driven by effective evidence
- canonical 1.3 answer semantics with separate resolution, evidence source, confirmation, and follow-up state
- Answered / Already Known / Skip / N/A / Must Confirm compatibility controls over the semantic model
- known-fact provenance
- recent local sessions and resume
- explicit sequential local upgrades from legacy 1.0 → pinned 1.1 → pinned 1.2 → semantic 1.3 with each source archived unchanged
- exact canonical 1.3 JSON import/export
- deterministic Markdown generation from canonical JSON
- client-safe read-back separated from internal notes
- responsive interviewer cockpit

Remote Google Drive sync, attachments, AI, MCP, BYOK, Owner Console integration, and a pack-builder UI are intentionally later gates.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## Data and security boundary

Public source, tests, screenshots, and demos must use synthetic/public-safe data only. Never commit credentials, tokens, private Drive identifiers, real client interview records, PHI, CUI, payment data, or customer secrets.

Local interview data is stored in IndexedDB. Cache Storage is reserved for the application shell. Browser storage can still be removed by browser/device/user policy, so JSON export remains the explicit backup path.

Session schema 1.3 is the only current load/import format and records `effective-evidence-equals-v2` independently in the pinned pack snapshot. Older local rows are accepted only by the explicit Upgrade path. Stored upgrades are sequential and fail closed: 1.0 → 1.1, 1.1 → 1.2, then 1.2 → 1.3, with each exact source archived before the next current row is committed. Normal JSON import requires canonical 1.3 rather than silently migrating an imported older record. Unsupported pack/rule versions in recognizable versioned rows (including future numeric schema versions) are eligible for an internal recovery backup only when the row has a nonempty session ID and can be serialized losslessly as bounded JSON. Recovery backups are limited to 2 MB of output, 256 KB per string, 1 MB of total strings, 100 levels of nesting, and 100,000 values. Unsupported rows that exceed these limits or cannot be serialized losslessly remain stored and unchanged.

Pack identity uses the browser's built-in Web Crypto. That API is available in a secure context (HTTPS or localhost). Opening the app over plain HTTP on another device on the LAN cannot compute the pack digest.

## Authority

Product authority and roadmap are tracked in this repository's issues, rooted in `LowcountryDigitalWorks/business-operations#753`. Repository-local implementation truth belongs here.

## License

A repository license has **not yet been selected**. The decision is intentionally deferred to an LDW portfolio-wide licensing review. Do not represent this repository as licensed or copy third-party source into it in the meantime.
