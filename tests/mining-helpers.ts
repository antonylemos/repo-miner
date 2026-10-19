import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from '@tests/sampling-helpers.js';
import { writeCsv } from '@/common/csv.js';
import { contentHash } from '@/modules/acquisition/content-hash.js';

export type FixtureFile = string | { content: string; executable?: boolean };

export type FixtureRepository = {
  fullName: string;
  files: Record<string, FixtureFile>;
};

const content = (file: FixtureFile) =>
  typeof file === 'string' ? file : file.content;
const executable = (file: FixtureFile) =>
  typeof file !== 'string' && file.executable === true;

/**
 * Writes an acquisition the way `acquire` leaves it: `corpus/<owner>__<name>/`
 * with `files/` and `normalization.json`, `acquisition.csv` and `manifest.json`.
 * The hashes are the real ones, so the acquisition is intact until a test edits it.
 */
export async function createAcquisition(
  repositories: FixtureRepository[],
  directory = join(temporaryDirectory(), 'acquisition'),
) {
  mkdirSync(join(directory, 'corpus'), { recursive: true });
  const rows: unknown[][] = [];
  for (const [index, repository] of repositories.entries()) {
    const name = repository.fullName.replace('/', '__');
    const snapshot = join(directory, 'corpus', name);
    const entries = Object.entries(repository.files).map(([path, file]) => {
      const target = join(snapshot, 'files', path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content(file));
      chmodSync(target, executable(file) ? 0o755 : 0o644);
      return {
        path,
        mode: executable(file) ? '100755' : '100644',
        sha256: createHash('sha256').update(content(file)).digest('hex'),
      };
    });
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    const sha = contentHash(entries);
    writeFileSync(
      join(snapshot, 'normalization.json'),
      JSON.stringify({ schema: 1, contentSha256: sha }),
    );
    rows.push([index + 1, repository.fullName, sha]);
  }
  await writeCsv(
    join(directory, 'acquisition.csv'),
    ['id', 'full_name', 'content_sha256'],
    rows,
  );
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({ schema: 1 }),
  );
  return {
    directory,
    snapshot: (fullName: string) =>
      join(directory, 'corpus', fullName.replace('/', '__')),
  };
}
