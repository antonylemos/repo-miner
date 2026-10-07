import { createHash } from 'node:crypto';
import { canonicalJson } from '@/common/canonical-json.js';
import { isIsoDate } from '@/common/dates.js';
import { isRecord } from '@/common/records.js';
import type {
  EligibilityRule,
  Protocol,
} from '@/modules/discovery/model/study.js';
import { ruleFor } from './registry.js';

export function parseProtocol(input: unknown): Protocol {
  if (!isRecord(input) || !Array.isArray(input.eligibility)) {
    throw new Error('Invalid protocol: expected an eligibility array');
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
    const definition = ruleFor(value.type);
    if (!definition)
      throw new Error(`Invalid protocol rule "${value.id}": unknown type`);
    return definition.parse(value, base);
  });
  return { eligibility };
}

export function protocolHash(protocol: Protocol): string {
  return createHash('sha256').update(canonicalJson(protocol)).digest('hex');
}

/** A run evaluates eligibility only when its protocol declares at least one rule. */
export function hasEligibility(protocol: Protocol): boolean {
  return protocol.eligibility.length > 0;
}
