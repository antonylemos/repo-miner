import { describe, expect, it } from 'vitest';
import {
  parseProtocol,
  protocolHash,
} from '../src/discovery/eligibility/protocol.js';

const push = { id: 'push', type: 'last_push', since: '2025-04-01' };
const recent = {
  id: 'human',
  type: 'recent_commit',
  since: '2025-04-01',
  dateField: 'committedDate',
  branches: 'all',
  authors: 'human',
};
describe('protocol', () => {
  it('rejects_unknown_rule_and_duplicate_id', () => {
    for (const eligibility of [[{ ...push, type: 'unknown' }], [push, push]]) {
      expect(() => parseProtocol({ version: 1, eligibility })).toThrow();
    }
  });
  it('rejects_invalid_dates_and_options', () => {
    for (const rule of [
      { ...push, since: '2025-02-29' },
      { ...recent, dateField: 'authoredDate' },
      { ...recent, branches: 'some' },
      { ...recent, authors: 'bot' },
      { ...recent, id: '' },
    ]) {
      expect(() =>
        parseProtocol({ version: 1, eligibility: [rule] }),
      ).toThrow();
    }
    expect(
      parseProtocol({ version: 1, eligibility: [recent] }).eligibility[0].since,
    ).toBe('2025-04-01');
    for (const input of [
      null,
      {},
      { version: 2, eligibility: [] },
      { version: 1 },
    ])
      expect(() => parseProtocol(input)).toThrow();
  });
  it('hash_preserves_rule_and_query_order', () => {
    const protocol = parseProtocol({ version: 1, eligibility: [push, recent] });
    expect(protocolHash(protocol)).not.toBe(
      protocolHash(parseProtocol({ version: 1, eligibility: [recent, push] })),
    );
    expect(protocolHash(protocol)).toBe(
      protocolHash(
        parseProtocol({
          eligibility: [
            Object.fromEntries(Object.entries(push).reverse()),
            recent,
          ],
          version: 1,
        }),
      ),
    );
  });
});
