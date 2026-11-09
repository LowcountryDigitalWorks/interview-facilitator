# Offline interview pack catalog — initial live choice

Authority: [product roadmap #5](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/5), [business-operations #753](https://github.com/LowcountryDigitalWorks/business-operations/issues/753).

This change makes five **real, empty-context** interview templates selectable in the existing schema 1.3 local-first New Interview flow:

| Pack ID | Interview type |
| --- | --- |
| `general-discovery-blank` | General discovery (default) |
| `website-greenfield` | New website / online presence |
| `website-takeover` | Existing website / platform takeover |
| `workflow-automation` | Workflow / automation |
| `technology-ownership` | Technology / ownership review |

Each template includes deliberately human-led, domain-specific prompts and, when applicable, a conditional question that only appears after a matching choice. **No known facts are preloaded.** There are no client identifiers, credentials, vendor connections, hidden background source reads or automatic assumptions about a customer. Never enter passwords, recovery codes or confidential regulated information in a public issue or test fixture.

The former `generalDiscoveryPack` carries a synthetic pre-interview known fact needed by existing source/CI fixtures. It remains a legacy test fixture, **excluded from the live New Interview selector**. The default live general pack preserves the same broad question sequence without that fabricated customer fact. This prevents an unsuspecting interviewer from treating the sample website fact as actual client research.

When an interviewer chooses a template and clicks **Start interview**, the application creates a validated canonical 1.3 session that pins a snapshot and SHA-256 pack digest. Existing local interviews retain their previously saved question snapshot and are not migrated, relabeled or rewritten when the template catalog changes. On-device save and export continue through the existing validated storage pipeline; no new database/remote service or ongoing cost is added.

This is **live local pack selection**, not a claim of automated client preparation, active ClientOps stage detection, owner-console launch, real client import, authenticated synchronization or completed production pilot. Those are governed separately by [#105](https://github.com/LowcountryDigitalWorks/interview-facilitator/issues/105), [Owner Console #16](https://github.com/LowcountryDigitalWorks/owner-console/issues/16) and [ClientOps #175](https://github.com/LowcountryDigitalWorks/business-operations/issues/175). Offline core remains usable without provider access.

Release acceptance requires exact-head unit and browser tests for all five templates, independent source/influence-clean review, guarded merge and post-merge CI. Physical mobile/Safari, accessibility and release/privacy gates remain open, including any future real-client pilot.
