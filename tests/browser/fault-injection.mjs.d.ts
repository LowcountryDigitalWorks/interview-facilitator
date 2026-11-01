import type { Page } from '@playwright/test';

export declare const DB_NAME: string;
export declare const STORE: string;
export declare function installIdbFaultInjection(page: Page): Promise<void>;
export declare function setIdbFault(
  page: Page,
  patch: Partial<{ blockOpen: boolean; blockWrite: boolean; blockRead: boolean }>,
): Promise<void>;
export declare function clearLocalState(page: Page): Promise<void>;
export declare function putRawSession(page: Page, row: unknown): Promise<void>;
export declare function listStoredSessionIds(page: Page): Promise<string[]>;
export declare function readStoredAnswer(page: Page, sessionId: string): Promise<string | null>;
export declare function startFreshInterview(page: Page, clientLabel?: string): Promise<void>;
export declare function openSeededInterviewOnLastQuestion(page: Page, clientLabel: string): Promise<void>;
export declare function openPrivateReview(page: Page): Promise<void>;
export declare function navigateHomeKeepingActiveSession(page: Page): Promise<void>;
export declare function startNewInterviewWhileActive(page: Page, clientLabel?: string): Promise<void>;
