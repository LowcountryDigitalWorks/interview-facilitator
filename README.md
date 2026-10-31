# Interview Facilitator

An offline-first, human-led interview/discovery cockpit from Lowcountry Digital Works.

The facilitator is designed to keep a real conversation natural while quietly tracking question coverage, known context, unresolved items, notes, and deterministic records. It is **not** a CRM, public intake form, chatbot, recorder, or autonomous qualification system.

## Current vertical slice

- TypeScript + Vite, no application framework
- installable PWA shell
- local IndexedDB session persistence
- one synthetic generic discovery pack
- deterministic conditional question visibility
- Answered / Already Known / Skip / N/A / Must Confirm status model
- known-fact provenance
- recent local sessions and resume
- exact JSON import/export
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

## Authority

Product authority and roadmap are tracked in this repository's issues, rooted in `LowcountryDigitalWorks/business-operations#753`. Repository-local implementation truth belongs here.

## License

A repository license has **not yet been selected**. The decision is intentionally deferred to an LDW portfolio-wide licensing review. Do not represent this repository as licensed or copy third-party source into it in the meantime.
