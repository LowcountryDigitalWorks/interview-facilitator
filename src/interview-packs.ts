import type { InterviewPack } from './domain';
import { generalDiscoveryPack } from './pack';

/**
 * Live, offline-capable human interview templates. No client-specific facts,
 * credentials or remotely fetched material may be embedded in these packs.
 * Previously saved sessions retain their independent pinned pack snapshot.
 *
 * The legacy generalDiscoveryPack with synthetic fact is deliberately NOT
 * exposed by this live catalog; it remains available to synthetic tests.
 */
const cleanGeneral: InterviewPack = {
  ...structuredClone(generalDiscoveryPack),
  packId: 'general-discovery-blank',
  title: 'General discovery',
  description: 'Broad discovery when the project does not yet fit a specialist interview.',
  knownFacts: [],
};

const greenfield: InterviewPack = {
  packSchemaVersion: '1.0.0', packId: 'website-greenfield', packVersion: '1.0.0',
  title: 'New website / online presence',
  description: 'Discover outcomes, audience, content and launch ownership for a new website.',
  knownFacts: [],
  sections: [
    { id: 'outcomes', title: 'Outcomes and audience' },
    { id: 'experience', title: 'Visitor journey' },
    { id: 'operations', title: 'Operations and ownership' },
    { id: 'launch', title: 'Launch readiness' },
  ],
  questions: [
    { id: 'primary-outcome', sectionId: 'outcomes', prompt: 'What should the website accomplish for the business?', kind: 'textarea' },
    { id: 'audience', sectionId: 'outcomes', prompt: 'Who are the primary audiences, and what matters to them?', kind: 'textarea' },
    { id: 'visitor-action', sectionId: 'experience', prompt: 'What is the most important action a visitor should take?', kind: 'textarea' },
    { id: 'must-have-pages', sectionId: 'experience', prompt: 'What content or pages must be ready for the first launch?', kind: 'textarea' },
    { id: 'needs-booking', sectionId: 'experience', prompt: 'Will the website need appointment or service requests?', kind: 'single', options: ['Yes', 'No', 'Not sure'] },
    { id: 'booking-details', sectionId: 'experience', prompt: 'What should happen after a visitor requests an appointment?', kind: 'textarea', condition: { questionId: 'needs-booking', equals: 'Yes' } },
    { id: 'content-owner', sectionId: 'operations', prompt: 'Who will supply and approve text, images and brand materials?', kind: 'textarea' },
    { id: 'domain-owner', sectionId: 'operations', prompt: 'Who is responsible for the domain and hosting decisions? Do not enter passwords.', kind: 'textarea' },
    { id: 'launch-priority', sectionId: 'launch', prompt: 'What is essential at launch, and what can wait?', kind: 'textarea' },
    { id: 'success-measure', sectionId: 'launch', prompt: 'How will the team judge whether the first version succeeded?', kind: 'textarea' },
  ],
};

const takeover: InterviewPack = {
  packSchemaVersion: '1.0.0', packId: 'website-takeover', packVersion: '1.0.0',
  title: 'Existing website / platform takeover',
  description: 'Map current ownership, dependencies and continuity before proposing changes.',
  knownFacts: [],
  sections: [
    { id: 'state', title: 'Current state' },
    { id: 'access', title: 'Ownership and access' },
    { id: 'continuity', title: 'Continuity and risk' },
    { id: 'transition', title: 'Transition priorities' },
  ],
  questions: [
    { id: 'existing-platform', sectionId: 'state', prompt: 'What website, platform or digital property exists today?', kind: 'textarea' },
    { id: 'main-pain', sectionId: 'state', prompt: 'What is not working, or what needs to change?', kind: 'textarea' },
    { id: 'domain-hosting', sectionId: 'access', prompt: 'Which parties currently manage the domain, DNS and hosting? Do not share credentials.', kind: 'textarea' },
    { id: 'content-assets', sectionId: 'access', prompt: 'Who owns the website content, files, design and integrations?', kind: 'textarea' },
    { id: 'handoff-available', sectionId: 'access', prompt: 'Can the existing provider supply an authorized handoff?', kind: 'single', options: ['Yes', 'No', 'Not sure'] },
    { id: 'handoff-gaps', sectionId: 'access', prompt: 'Which assets or permissions are missing from the handoff?', kind: 'textarea', condition: { questionId: 'handoff-available', equals: 'No' } },
    { id: 'critical-dependencies', sectionId: 'continuity', prompt: 'Which forms, mailboxes, business systems or links must keep working?', kind: 'textarea' },
    { id: 'rollback', sectionId: 'continuity', prompt: 'What backups, rollback options or service windows are available?', kind: 'textarea' },
    { id: 'priority', sectionId: 'transition', prompt: 'What should be preserved, improved or retired first?', kind: 'textarea' },
    { id: 'approval', sectionId: 'transition', prompt: 'Who can authorize the migration, and what review is required?', kind: 'textarea' },
  ],
};

const automation: InterviewPack = {
  packSchemaVersion: '1.0.0', packId: 'workflow-automation', packVersion: '1.0.0',
  title: 'Workflow / automation',
  description: 'Describe current handoffs, exceptions and human decision points before automating.',
  knownFacts: [],
  sections: [
    { id: 'trigger', title: 'Trigger and outcome' },
    { id: 'current', title: 'Current process' },
    { id: 'controls', title: 'Controls and exceptions' },
    { id: 'success', title: 'Success and rollout' },
  ],
  questions: [
    { id: 'workflow-outcome', sectionId: 'trigger', prompt: 'What result should this workflow reliably produce?', kind: 'textarea' },
    { id: 'event-trigger', sectionId: 'trigger', prompt: 'What event begins the workflow?', kind: 'textarea' },
    { id: 'actors', sectionId: 'current', prompt: 'Who participates, and where does work change hands?', kind: 'textarea' },
    { id: 'systems', sectionId: 'current', prompt: 'What systems and data categories are involved? Do not enter secrets.', kind: 'textarea' },
    { id: 'current-steps', sectionId: 'current', prompt: 'Walk through the current process from beginning to end.', kind: 'textarea' },
    { id: 'approval-required', sectionId: 'controls', prompt: 'Must a person approve any step before it happens?', kind: 'single', options: ['Yes', 'No', 'Not sure'] },
    { id: 'approval-points', sectionId: 'controls', prompt: 'Which decisions must stay human-controlled?', kind: 'textarea', condition: { questionId: 'approval-required', equals: 'Yes' } },
    { id: 'exceptions', sectionId: 'controls', prompt: 'What happens when information is missing, duplicated or incorrect?', kind: 'textarea' },
    { id: 'audit-retention', sectionId: 'controls', prompt: 'What history, notifications or retention rules are needed?', kind: 'textarea' },
    { id: 'first-proof', sectionId: 'success', prompt: 'What small, reversible proof would establish value?', kind: 'textarea' },
    { id: 'success-criteria', sectionId: 'success', prompt: 'Which measures would show the automation is working?', kind: 'textarea' },
  ],
};

const technology: InterviewPack = {
  packSchemaVersion: '1.0.0', packId: 'technology-ownership', packVersion: '1.0.0',
  title: 'Technology / ownership review',
  description: 'Identify accountable owners, platforms, dependencies, risks and recovery needs.',
  knownFacts: [],
  sections: [
    { id: 'inventory', title: 'Systems and purpose' },
    { id: 'ownership', title: 'Ownership and responsibility' },
    { id: 'resilience', title: 'Security and resilience' },
    { id: 'decisions', title: 'Priority decisions' },
  ],
  questions: [
    { id: 'business-services', sectionId: 'inventory', prompt: 'Which business services or capabilities depend on this technology?', kind: 'textarea' },
    { id: 'systems-inventory', sectionId: 'inventory', prompt: 'What major devices, platforms, applications or providers are involved?', kind: 'textarea' },
    { id: 'critical-owners', sectionId: 'ownership', prompt: 'Who makes decisions and administers each critical system? Never record passwords.', kind: 'textarea' },
    { id: 'vendor-contracts', sectionId: 'ownership', prompt: 'What support, vendor or renewal dependencies should be known?', kind: 'textarea' },
    { id: 'access-handoffs', sectionId: 'ownership', prompt: 'Where is ownership or authorized access unclear?', kind: 'textarea' },
    { id: 'backup-exists', sectionId: 'resilience', prompt: 'Is there an established backup and restore process?', kind: 'single', options: ['Yes', 'No', 'Not sure'] },
    { id: 'restore-evidence', sectionId: 'resilience', prompt: 'When and how was restore capability last verified?', kind: 'textarea', condition: { questionId: 'backup-exists', equals: 'Yes' } },
    { id: 'high-risks', sectionId: 'resilience', prompt: 'Which outages, access gaps or compliance requirements matter most?', kind: 'textarea' },
    { id: 'near-term', sectionId: 'decisions', prompt: 'What is the highest-value change to make first?', kind: 'textarea' },
    { id: 'decision-authority', sectionId: 'decisions', prompt: 'Who authorizes changes and accepts remaining risks?', kind: 'textarea' },
  ],
};

const DEFINITIONS: readonly InterviewPack[] = [
  cleanGeneral, greenfield, takeover, automation, technology,
];
export const DEFAULT_INTERVIEW_PACK_ID = cleanGeneral.packId;

/** Public template metadata only. No client/source facts or provider access. */
export const LIVE_INTERVIEW_PACK_OPTIONS: ReadonlyArray<{
  id: string; title: string; description: string; version: string; questions: number;
}> = DEFINITIONS.map(p => ({
  id: p.packId, title: p.title, description: p.description,
  version: p.packVersion, questions: p.questions.length,
}));

/** Return a defensive copy to prevent edits from changing a shared template. */
export function findLiveInterviewPack(rawId: unknown): InterviewPack | null {
  if (typeof rawId !== 'string') return null;
  const selected = DEFINITIONS.find(p => p.packId === rawId);
  return selected ? structuredClone(selected) : null;
}

export function defaultLiveInterviewPack(): InterviewPack {
  const selected = findLiveInterviewPack(DEFAULT_INTERVIEW_PACK_ID);
  if (!selected) throw new Error('Default interview template is unavailable.');
  return selected;
}
