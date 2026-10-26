import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256File } from '@/common/hash.js';
import type { ReviewVariable } from '@/modules/profile/config.js';
import { readReviews } from '@/modules/profile/reviews.js';

afterEach(removeTemporaryDirectories);

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);

type Fixture = {
  fullName: string;
  commit?: string;
  status?: string;
  body: string;
};

/** Writes review files in a directory and returns a glob that finds them. */
function reviews(files: Fixture[]): string {
  const directory = temporaryDirectory();
  mkdirSync(directory, { recursive: true });
  for (const [index, file] of files.entries()) {
    writeFileSync(
      join(directory, `${String(index + 1).padStart(3, '0')}-review.md`),
      `---\nschema: 1\nfull_name: ${file.fullName}\ncommit: ${file.commit ?? COMMIT}\nannotation:\n  status: ${file.status ?? 'final'}\n---\n\n${file.body}\n`,
    );
  }
  return join(directory, '[0-9]*.md');
}

const repositories = [{ fullName: 'org/a', commitSha: COMMIT }];

const number = (files: string): ReviewVariable => ({
  name: 'apps',
  files,
  statuses: ['final'],
  extractor: { kind: 'number', pattern: /Apps:\s*(\d+)/m },
});

const list = (files: string, empty = ['none']): ReviewVariable => ({
  name: 'unrelated',
  files,
  statuses: ['final'],
  extractor: {
    kind: 'list',
    pattern: /Unrelated:\s*(.+?)\.?\s*$/m,
    separator: ',',
    empty,
  },
});

const column = (files: string): ReviewVariable => ({
  name: 'types',
  files,
  statuses: ['final'],
  extractor: { kind: 'column', section: 'Relations', header: 'Type' },
});

describe('readReviews', () => {
  it('should read a number and hash the file', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'Apps: 5' }]);
    const reading = await readReviews([number(files)], repositories);
    expect(reading.values.get('org/a')).toEqual({ apps: '5' });
    const [path] = Object.keys(reading.files);
    expect(reading.files[path as string]).toBe(
      await sha256File(path as string),
    );
  });

  it('should match the repository by full_name and not by file order', async () => {
    const files = reviews([
      { fullName: 'org/b', body: 'Apps: 9' },
      { fullName: 'org/a', body: 'Apps: 2' },
    ]);
    const reading = await readReviews(
      [number(files)],
      [...repositories, { fullName: 'org/b', commitSha: COMMIT }],
    );
    expect(reading.values.get('org/a')?.apps).toBe('2');
    expect(reading.values.get('org/b')?.apps).toBe('9');
  });

  it('should count an empty list as 0', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'Unrelated: none.' }]);
    const reading = await readReviews([list(files)], repositories);
    expect(reading.values.get('org/a')?.unrelated).toBe('0');
  });

  it('should count the items of a list', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'Unrelated: a, b, c.' }]);
    const reading = await readReviews([list(files)], repositories);
    expect(reading.values.get('org/a')?.unrelated).toBe('3');
  });

  it('should join the distinct, ordered values of a column', async () => {
    const files = reviews([
      {
        fullName: 'org/a',
        body: [
          '## Relations',
          '',
          '| # | From | Type |',
          '|---|---|---|',
          '| 1 | x | host → remote |',
          '| 2 | y | communication |',
          '| 3 | z | host → remote |',
          '',
          '## Notes',
          '',
          '| # | Type |',
          '|---|---|',
          '| 1 | other |',
        ].join('\n'),
      },
    ]);
    const reading = await readReviews([column(files)], repositories);
    expect(reading.values.get('org/a')?.types).toBe(
      'communication;host → remote',
    );
  });

  it('should give an empty value for a section without a table', async () => {
    const files = reviews([
      { fullName: 'org/a', body: '## Relations\n\nNo relations.\n\n## Notes' },
    ]);
    const reading = await readReviews([column(files)], repositories);
    expect(reading.values.get('org/a')?.types).toBe('');
  });

  it('should give an empty value for a table without rows', async () => {
    const files = reviews([
      {
        fullName: 'org/a',
        body: '## Relations\n\n| # | Type |\n|---|---|\n',
      },
    ]);
    const reading = await readReviews([column(files)], repositories);
    expect(reading.values.get('org/a')?.types).toBe('');
  });

  it('should not read the front matter as text of the review', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'no match here' }]);
    await expect(
      readReviews(
        [
          {
            ...number(files),
            extractor: { kind: 'number', pattern: /status:\s*(\w+)/m },
          },
        ],
        repositories,
      ),
    ).rejects.toThrow(/did not match/);
  });

  it('should reject a review that is still a draft', async () => {
    const files = reviews([
      { fullName: 'org/a', status: 'draft', body: 'Apps: 1' },
    ]);
    await expect(readReviews([number(files)], repositories)).rejects.toThrow(
      /org\/a.*001-review\.md.*draft/,
    );
  });

  it('should reject a review of another commit', async () => {
    const files = reviews([
      { fullName: 'org/a', commit: OTHER_COMMIT, body: 'Apps: 1' },
    ]);
    await expect(readReviews([number(files)], repositories)).rejects.toThrow(
      new RegExp(`${OTHER_COMMIT}.*${COMMIT}`),
    );
  });

  it('should reject a repository with two reviews and one with none', async () => {
    const files = reviews([
      { fullName: 'org/a', body: 'Apps: 1' },
      { fullName: 'org/a', body: 'Apps: 2' },
    ]);
    const error = await readReviews(
      [number(files)],
      [...repositories, { fullName: 'org/c', commitSha: COMMIT }],
    ).catch((failure: Error) => failure);
    expect((error as Error).message).toMatch(/2 problems/);
    expect((error as Error).message).toMatch(/org\/a.*2 review files/);
    expect((error as Error).message).toMatch(/org\/c.*no review file/);
  });

  it('should reject a pattern that does not match and name the file and variable', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'nothing' }]);
    await expect(readReviews([number(files)], repositories)).rejects.toThrow(
      /org\/a \(apps\).*001-review\.md.*did not match/,
    );
  });

  it('should reject a number that is not an integer', async () => {
    const files = reviews([{ fullName: 'org/a', body: 'Apps: 1.5' }]);
    await expect(
      readReviews(
        [
          {
            ...number(files),
            extractor: { kind: 'number', pattern: /Apps:\s*([\d.]+)/m },
          },
        ],
        repositories,
      ),
    ).rejects.toThrow(/not an integer/);
  });

  it('should reject a missing section and a missing column', async () => {
    const noSection = reviews([{ fullName: 'org/a', body: 'text' }]);
    await expect(
      readReviews([column(noSection)], repositories),
    ).rejects.toThrow(/no section ## Relations/);
    const noColumn = reviews([
      { fullName: 'org/a', body: '## Relations\n\n| # | Other |\n|---|---|\n' },
    ]);
    await expect(readReviews([column(noColumn)], repositories)).rejects.toThrow(
      /no column Type/,
    );
  });

  it('should report a file without front matter', async () => {
    const directory = temporaryDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '001.md'), 'Apps: 1\n');
    await expect(
      readReviews([number(join(directory, '[0-9]*.md'))], repositories),
    ).rejects.toThrow(/no YAML front matter/);
  });
});
