import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCsv, writeCsv } from '@/common/csv.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fileWith(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'csv-'));
  directories.push(directory);
  const path = join(directory, 'file.csv');
  writeFileSync(path, content);
  return path;
}

async function rowsOf(path: string): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const row of readCsv(path)) rows.push(row);
  return rows;
}

describe('readCsv', () => {
  it('should read plain records with and without a final line break', async () => {
    expect(await rowsOf(fileWith('a,b\n1,2\n'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(await rowsOf(fileWith('a,b\n1,2'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('should keep empty fields, including a trailing one', async () => {
    expect(await rowsOf(fileWith('a,,c\n1,2,\n'))).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('should read commas, line breaks and doubled quotes inside quotes', async () => {
    expect(await rowsOf(fileWith('id,text\n1,"a, ""b""\nc"\n2,"x"\n'))).toEqual(
      [
        ['id', 'text'],
        ['1', 'a, "b"\nc'],
        ['2', 'x'],
      ],
    );
  });

  it('should treat CRLF as a record end and ignore a byte order mark', async () => {
    expect(await rowsOf(fileWith('﻿a,b\r\n1,2\r\n'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('should keep an empty quoted field as an empty value', async () => {
    expect(await rowsOf(fileWith('a,""\n""\n'))).toEqual([['a', ''], ['']]);
  });

  it('should read fields larger than 128 KB', async () => {
    const big = `${'x,"\n'.repeat(60_000)}end`;
    const escaped = `"${big.replaceAll('"', '""')}"`;
    expect(big.length).toBeGreaterThan(128 * 1024);
    expect(await rowsOf(fileWith(`id,big\n1,${escaped}\n`))).toEqual([
      ['id', 'big'],
      ['1', big],
    ]);
  });

  it('should fail on an unterminated quoted field', async () => {
    await expect(rowsOf(fileWith('a,"open\n'))).rejects.toThrow(/unterminated/);
  });

  it('should round-trip what writeCsv writes', async () => {
    const path = fileWith('');
    const rows = [
      ['1', 'plain', ''],
      ['2', 'with, comma', 'say "hi"'],
      ['3', 'line\nbreak', 'a\r\nb'],
    ];
    await writeCsv(path, ['id', 'x', 'y'], rows);
    expect(await rowsOf(path)).toEqual([['id', 'x', 'y'], ...rows]);
  });
});
