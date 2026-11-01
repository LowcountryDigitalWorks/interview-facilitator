import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import type { Result } from 'axe-core';

export async function expectNoSeriousOrCriticalAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(blocking, formatAxeViolations(blocking)).toEqual([]);
}

function formatAxeViolations(violations: Result[]): string {
  if (!violations.length) return '';
  return violations
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.description}\n${violation.nodes.map((node) => node.target.join(' ')).join('\n')}`)
    .join('\n\n');
}
