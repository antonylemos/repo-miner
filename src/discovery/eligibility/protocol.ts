import { createHash } from 'node:crypto';
import { canonicalJson, isIsoDate } from '../catalog.js';
import type { EligibilityRule, Protocol } from './types.js';

export function parseProtocol(input: unknown): Protocol {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    !Array.isArray(input.eligibility)
  ) {
    throw new Error(
      'Invalid protocol: expected version 1 and an eligibility array',
    );
  }
  const ids = new Set<string>();
  const eligibility = input.eligibility.map((value, index): EligibilityRule => {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error(
        `Invalid protocol rule at index ${index}: id must be a non-empty string`,
      );
    }
    if (ids.has(value.id))
      throw new Error(`Invalid protocol: duplicate rule id "${value.id}"`);
    ids.add(value.id);
    if (!isIsoDate(value.since))
      throw new Error(
        `Invalid protocol rule "${value.id}": since must be a YYYY-MM-DD date`,
      );
    const base = { id: value.id, since: value.since };
    if (value.type === 'last_push') return { ...base, type: 'last_push' };
    if (value.type !== 'recent_commit')
      throw new Error(`Invalid protocol rule "${value.id}": unknown type`);
    if (
      value.dateField !== 'committedDate' ||
      (value.branches !== 'all' && value.branches !== 'default') ||
      (value.authors !== 'human' && value.authors !== 'any')
    ) {
      throw new Error(
        `Invalid protocol rule "${value.id}": expected committedDate, branches all/default and authors human/any`,
      );
    }
    return {
      ...base,
      type: 'recent_commit',
      dateField: value.dateField,
      branches: value.branches,
      authors: value.authors,
    };
  });
  return { version: 1, eligibility };
}

export function protocolHash(protocol: Protocol): string {
  return createHash('sha256').update(canonicalJson(protocol)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
