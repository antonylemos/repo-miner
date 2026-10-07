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
  it('should reject unknown rule and duplicate id', () => {
    for (const eligibility of [[{ ...push, type: 'unknown' }], [push, push]]) {
      expect(() => parseProtocol({ eligibility })).toThrow();
    }
  });
  it('should reject invalid dates and options', () => {
    for (const rule of [
      { ...push, since: '2025-02-29' },
      { ...recent, dateField: 'authoredDate' },
      { ...recent, branches: 'some' },
      { ...recent, authors: 'bot' },
      { ...recent, id: '' },
    ]) {
      expect(() => parseProtocol({ eligibility: [rule] })).toThrow();
    }
    expect(parseProtocol({ eligibility: [recent] }).eligibility[0].since).toBe(
      '2025-04-01',
    );
    for (const input of [null, {}, { eligibility: 'all' }, { version: 1 }])
      expect(() => parseProtocol(input)).toThrow();
  });
  it('should preserve rule and query order in the hash', () => {
    const protocol = parseProtocol({ eligibility: [push, recent] });
    expect(protocolHash(protocol)).not.toBe(
      protocolHash(parseProtocol({ eligibility: [recent, push] })),
    );
    expect(protocolHash(protocol)).toBe(
      protocolHash(
        parseProtocol({
          eligibility: [
            Object.fromEntries(Object.entries(push).reverse()),
            recent,
          ],
        }),
      ),
    );
  });
});
