import type { InterviewPack } from './domain';

export const generalDiscoveryPack: InterviewPack = {
  packSchemaVersion: '1.0.0',
  packId: 'general-discovery',
  packVersion: '1.0.0',
  title: 'General discovery',
  description: 'A synthetic, reusable discovery pack for validating the interview cockpit.',
  sections: [
    { id: 'context', title: 'Context' },
    { id: 'goals', title: 'Goals' },
    { id: 'operations', title: 'Operations' },
    { id: 'wrap', title: 'Wrap-up' }
  ],
  knownFacts: [
    {
      id: 'fact-existing-site',
      label: 'Existing online presence',
      value: 'A basic public website already exists.',
      provenance: 'Synthetic pre-interview research',
      questionId: 'existing-presence'
    }
  ],
  questions: [
    {
      id: 'existing-presence',
      sectionId: 'context',
      prompt: 'What is already in place today?',
      help: 'Confirm the known context or capture what has changed.',
      kind: 'textarea'
    },
    {
      id: 'primary-goal',
      sectionId: 'goals',
      prompt: 'What outcome matters most from this work?',
      kind: 'textarea'
    },
    {
      id: 'needs-booking',
      sectionId: 'operations',
      prompt: 'Do people need to request or book time?',
      kind: 'single',
      options: ['Yes', 'No', 'Not sure']
    },
    {
      id: 'booking-process',
      sectionId: 'operations',
      prompt: 'How should booking or scheduling work?',
      kind: 'textarea',
      condition: { questionId: 'needs-booking', equals: 'Yes' }
    },
    {
      id: 'must-have',
      sectionId: 'wrap',
      prompt: 'What absolutely has to be true for the first version to feel successful?',
      kind: 'textarea'
    }
  ]
};
