import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from '@tests/sampling-helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { appendToCatalog } from '@/modules/sampling/catalog.js';

afterEach(removeTemporaryDirectories);

const entry = (id: number) => ({
  id,
  url: `https://github.com/org/repo-${id}`,
});
const pathOf = () => join(temporaryDirectory(), 'catalog.csv');
const text = (path: string) => readFileSync(path, 'utf8');

describe('appendToCatalog', () => {
  it('should create the catalog with a header and empty classifications', async () => {
    const path = pathOf();
    expect(await appendToCatalog(path, [entry(1), entry(2)])).toBe(2);
    expect(text(path)).toBe(
      'id,url,classification\n' +
        '1,https://github.com/org/repo-1,\n' +
        '2,https://github.com/org/repo-2,\n',
    );
  });

  it('should only append ids that are not in the catalog', async () => {
    const path = pathOf();
    await appendToCatalog(path, [entry(1)]);
    expect(await appendToCatalog(path, [entry(1), entry(2)])).toBe(1);
    expect(text(path).trimEnd().split('\n')).toHaveLength(3);
  });

  it('should keep filled classifications and extra columns byte for byte', async () => {
    const path = pathOf();
    const existing =
      'id,url,classification,notes\n' +
      '1,https://github.com/org/repo-1,MFE-implemented,"checked, twice"\n' +
      '2,https://github.com/org/repo-2,Non-MFE,\n';
    writeFileSync(path, existing);
    await appendToCatalog(path, [entry(2), entry(3)]);
    expect(text(path)).toBe(`${existing}3,https://github.com/org/repo-3,,\n`);
  });

  it('should add the missing final line break before appending', async () => {
    const path = pathOf();
    const existing =
      'id,url,classification\n1,https://github.com/org/repo-1,Non-MFE';
    writeFileSync(path, existing);
    await appendToCatalog(path, [entry(2)]);
    expect(text(path)).toBe(`${existing}\n2,https://github.com/org/repo-2,\n`);
  });

  it('should write each value under its own column when the header was reordered', async () => {
    const path = pathOf();
    writeFileSync(path, 'notes,id,classification,url\n');
    await appendToCatalog(path, [entry(7)]);
    expect(text(path)).toBe(
      'notes,id,classification,url\n,7,,https://github.com/org/repo-7\n',
    );
  });

  it('should find the id column wherever the researcher moved it', async () => {
    const path = pathOf();
    writeFileSync(path, 'classification,url,id\nNon-MFE,https://x,5\n');
    expect(await appendToCatalog(path, [entry(5), entry(6)])).toBe(1);
  });

  it('should fail instead of duplicating rows when the file is unreadable', async () => {
    const path = pathOf();
    writeFileSync(path, 'id,url,classification\n1,"broken\n');
    await expect(appendToCatalog(path, [entry(2)])).rejects.toThrow(
      /unterminated/,
    );
  });

  it('should not write anything when there is nothing new', async () => {
    const path = pathOf();
    await appendToCatalog(path, [entry(1)]);
    const before = text(path);
    expect(await appendToCatalog(path, [entry(1)])).toBe(0);
    expect(text(path)).toBe(before);
  });
});
