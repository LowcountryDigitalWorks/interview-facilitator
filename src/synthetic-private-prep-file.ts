import { prepareInterviewCandidateReviewForReview, type InterviewPrepPacket } from './interview-workflow-bridge';
import type { SemanticInterviewSession } from './semantic-session';

/**
 * PREP-BRIDGE-001: trial adapter for a SYNTHETIC local JSON file only.
 * This is not an authenticated source adapter, client authorization, import
 * into IndexedDB, or a route for actual customer data. No network or storage.
 */
export const SYNTHETIC_PREP_MAX_BYTES = 512 * 1024;

export function isSyntheticPrepTrialSession(clientLabel: string): boolean {
  return /^synthetic(?:\s|[-_])/i.test(clientLabel);
}

export async function readSyntheticPrepPacketForReview(
  file: Pick<File, 'size' | 'text'>,
  source: SemanticInterviewSession,
): Promise<InterviewPrepPacket> {
  // Refuse real-session input BEFORE reading even one byte of a local file.
  if (!isSyntheticPrepTrialSession(source.clientLabel)) {
    throw new Error('Private preparation trial accepts synthetic interview sessions only.');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > SYNTHETIC_PREP_MAX_BYTES) {
    throw new Error('Synthetic preparation file size exceeds the trial limit.');
  }

  const rawText = await file.text();
  if (new TextEncoder().encode(rawText).byteLength > SYNTHETIC_PREP_MAX_BYTES) {
    throw new Error('Synthetic preparation file exceeds the decoded size limit.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error('Synthetic preparation file is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Synthetic preparation file must contain a packet record.');
  }
  const packet = raw as Record<string, unknown>;
  if (typeof packet.jobKey !== 'string' || !/^SYNTHETIC-[a-z0-9._-]{1,100}$/i.test(packet.jobKey)) {
    throw new Error('The trial requires a synthetic job identity.');
  }
  if (!Array.isArray(packet.candidates)) {
    throw new Error('The trial requires a bounded synthetic candidate list.');
  }
  for (const candidate of packet.candidates as unknown[]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Synthetic source candidate is invalid.');
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.proposedValue !== 'string' || !/^synthetic(?:\s|[-_])/i.test(value.proposedValue)
      || typeof value.sourceRecordRef !== 'string' || !/^SYNTHETIC[-_]/i.test(value.sourceRecordRef)) {
      throw new Error('The trial cannot display a candidate without synthetic value and source markers.');
    }
  }
  // The accepted source contract verifies every field, pack and exact session
  // revision, duplicate identity, timestamps, source kind, and bounded count.
  await prepareInterviewCandidateReviewForReview(packet, source);
  return packet as unknown as InterviewPrepPacket;
}
