import { matchesGlob } from 'node:path';
import { compareCodePoints } from '@/common/order.js';
import { languageOf } from '@/modules/acquisition/measures.js';
import { listFiles } from '@/modules/mining/source.js';
import type { ProfileConfig } from './config.js';

export type LanguageGroup = 'measured' | 'context' | 'excluded';

export type LanguageRow = {
  language: string;
  group: LanguageGroup;
  files: number;
  bytes: number;
  /** Bytes over the bytes of all measured languages; null outside `measured`. */
  share: number | null;
};

export type LanguageProfile = {
  /** Every file of the snapshot, the excluded ones included. */
  files: number;
  excludedFiles: number;
  /** Ordered by language and then by group. */
  rows: LanguageRow[];
  /** Null when no file is of a measured language. */
  frontendShare: number | null;
  dominantLanguage: string | null;
};

const GROUPS: LanguageGroup[] = ['measured', 'context', 'excluded'];

/** The form of a proportion in the CSV files. */
export function formatShare(share: number | null): string {
  return share === null ? '' : share.toFixed(6);
}

/**
 * Measures the files of a snapshot by language. The files that match
 * `excludeFiles` are left out of every language sum and counted apart; the
 * proportions are over the measured languages only.
 */
export function measureLanguages(
  filesDirectory: string,
  languages: ProfileConfig['languages'],
): LanguageProfile {
  const files = listFiles(filesDirectory);
  const measured = new Set(languages.measured);
  const totals = new Map<string, { files: number; bytes: number }>();
  let excludedFiles = 0;
  let measuredBytes = 0;
  for (const file of files) {
    const excluded = languages.excludeFiles.some((glob) =>
      matchesGlob(file.path, glob),
    );
    const language = languageOf(file.path);
    const group: LanguageGroup = excluded
      ? 'excluded'
      : measured.has(language)
        ? 'measured'
        : 'context';
    if (excluded) excludedFiles += 1;
    else if (group === 'measured') measuredBytes += file.size;
    const key = `${group}\0${language}`;
    const total = totals.get(key) ?? { files: 0, bytes: 0 };
    total.files += 1;
    total.bytes += file.size;
    totals.set(key, total);
  }

  const rows = [...totals]
    .map(([key, total]): LanguageRow => {
      const [group, language] = key.split('\0') as [LanguageGroup, string];
      return {
        language,
        group,
        files: total.files,
        bytes: total.bytes,
        share:
          group === 'measured' && measuredBytes > 0
            ? total.bytes / measuredBytes
            : null,
      };
    })
    .sort(
      (a, b) =>
        compareCodePoints(a.language, b.language) ||
        GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group),
    );

  const frontend = new Set(languages.frontend);
  const frontendBytes = rows
    .filter((row) => row.group === 'measured' && frontend.has(row.language))
    .reduce((sum, row) => sum + row.bytes, 0);
  // Rows are ordered by name, so the first of the largest wins a tie alphabetically.
  let dominant: LanguageRow | null = null;
  for (const row of rows)
    if (row.group === 'measured' && row.bytes > (dominant?.bytes ?? 0))
      dominant = row;
  return {
    files: files.length,
    excludedFiles,
    rows,
    frontendShare: measuredBytes > 0 ? frontendBytes / measuredBytes : null,
    dominantLanguage: dominant?.language ?? null,
  };
}
