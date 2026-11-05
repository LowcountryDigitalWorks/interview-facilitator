import { describe, expect, it } from 'vitest';
import { knownFact14InternalInterviewReportForReview } from '../src/known-fact-internal-report-14';
import { migrateSemantic13ToKnownFact14 } from '../src/known-fact-session';
import { generalDiscoveryPack } from '../src/pack';
import { createSemanticSession } from '../src/semantic-session';
import { relevanceMap } from '../src/live-session';

const AT = '2026-11-04T20:00:00.000Z';
async function fixture() {
  const s = await createSemanticSession(generalDiscoveryPack,
    { clientLabel: 'PRIVATE SYNTHETIC CLIENT', interviewerLabel: 'PRIVATE INTERVIEWER' },
    new Date(AT));
  s.runningNotes = 'PRIVATE RUNNING NOTE\nSecond line';
  s.answers['primary-goal'] = {
    value: 'A current goal', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null,
    followUp: { action: 'PRIVATE FOLLOW-UP', owner: 'PRIVATE OWNER', dueDate: '2026-12-01' },
    note: 'PRIVATE QUESTION NOTE',
  };
  s.answers['booking-process'] = {
    value: 'PRIVATE HIDDEN RETAINED', resolution: 'captured', source: 'client-statement',
    needsConfirmation: false, confirmation: null, followUp: null, note: 'PRIVATE HIDDEN NOTE',
  };
  return migrateSemantic13ToKnownFact14(s);
}

describe('#35D internal deterministic 1.4 report', () => {
  it('includes notes, metadata, follow-ups, inactive evidence and is deterministic/nonmutating', async () => {
    const s = await fixture(), before = structuredClone(s);
    const report = await knownFact14InternalInterviewReportForReview(s);
    for (const token of [
      'INTERNAL / CONFIDENTIAL', 'not a client Read-back',
      'PRIVATE SYNTHETIC CLIENT', 'PRIVATE INTERVIEWER', 'PRIVATE RUNNING NOTE',
      'PRIVATE FOLLOW\\-UP', 'PRIVATE OWNER', 'PRIVATE QUESTION NOTE',
      'PRIVATE HIDDEN RETAINED', 'PRIVATE HIDDEN NOTE',
      '2026\\-12\\-01', 'Historical known-fact provenance',
    ]) expect(report).toContain(token);
    expect(report).toContain('Retained INTERNAL value');
    expect(report).toContain('Inactive / hidden preserved evidence');
    expect(report).toBe(await knownFact14InternalInterviewReportForReview(structuredClone(s)));
    expect(s).toEqual(before);
  });

  it('uses derived coverage, without claiming lifecycle completion or consent', async () => {
    const report = await knownFact14InternalInterviewReportForReview(await fixture());
    expect(report).toContain('Current coverage (derived, not completed-state approval)');
    expect(report).toContain('not client confirmation');
    expect(report).not.toContain('SIGNED BY');
  });

  it('does not treat interviewer inference as agreement', async () => {
    const s = await fixture();
    s.answers['primary-goal']!.source = 'interviewer-inference';
    const report = await knownFact14InternalInterviewReportForReview(s);
    expect(report).toContain('Interviewer inference \\(unconfirmed\\)');
    expect(report).toContain('**Needs human confirmation:** Yes');
    expect(report).toContain('**Current:** 0');
    expect(report).toContain('**Needs confirmation:** 1');
    expect(report).toContain('Needs confirmation');
  });

  it('escapes hostile Markdown HTML autolinks and Unicode separators', async () => {
    const s = await fixture();
    s.answers['primary-goal']!.value = '# ATTACK\n<script>alert(1)</script>\n===\n@evil.test';
    s.answers['primary-goal']!.note = 'visit https://attack.example\n### FAKE\nsomeone@attack.example';
    s.runningNotes = '<img src=x onerror=alert(1)>\r\n\n# FORGED\u2028===';
    const report = await knownFact14InternalInterviewReportForReview(s);
    expect(report).toContain('> \\# ATTACK');
    expect(report).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('<img');
    expect(report).not.toContain('\n# FORGED');
    expect(report).toContain('\\u2028');
    expect(report).not.toContain('someone@attack.example');
    expect(report).toContain('someone\\@attack\\.example');
    expect(report).toContain('\\=\\=\\=');
  });

  it('clearly separates pending state and hidden retained values', async () => {
    const s = await fixture();
    expect(relevanceMap(s)['booking-process']).toBe('pending');
    const answer = s.answers['booking-process']!;
    answer.resolution = 'deferred';
    answer.value = 'PRIVATE PENDING RETAINED';
    const report = await knownFact14InternalInterviewReportForReview(s);
    expect(report).toContain('Conditional / pending questions');
    expect(report).toContain('Conditional / pending — NOT current');
    expect(report).toContain('Retained INTERNAL value \\(NOT current evidence\\)');
    expect(report).toContain('PRIVATE PENDING RETAINED');
  });

  it('rejects legacy 1.3 or extra source fields', async () => {
    const old = await createSemanticSession(generalDiscoveryPack,
      { clientLabel: 'Synthetic legacy' }, new Date(AT));
    await expect(knownFact14InternalInterviewReportForReview(old)).rejects.toThrow(/schema version/i);
    const s = await fixture();
    await expect(knownFact14InternalInterviewReportForReview({
      ...s, unsupportedSourceField: 'PRIVATE',
    })).rejects.toThrow(/unsupported field/i);
  });
});
