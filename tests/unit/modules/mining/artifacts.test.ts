import { join } from 'node:path';
import { createAcquisition } from '@tests/mining-helpers.js';
import { describe, expect, it } from 'vitest';
import { assignTypes, listArtifacts } from '@/modules/mining/artifacts.js';

const file = (path: string, size = 1) => ({ path, size, executable: false });

describe('assignTypes', () => {
  it('should give a file every type whose globs match', () => {
    const [result] = assignTypes([file('package.json')], {
      'dependency-manifest': ['**/package.json'],
      'workspace-config': ['**/package.json'],
      documentation: ['**/*.md'],
    });
    expect(result?.types).toEqual(['dependency-manifest', 'workspace-config']);
  });

  it('should give no type to a file that no glob matches', () => {
    const [result] = assignTypes([file('assets/logo.svg')], {
      source: ['**/*.js'],
    });
    expect(result?.types).toEqual([]);
  });

  it('should expand braces in globs', () => {
    const result = assignTypes(
      [file('shell/src/App.tsx'), file('shell/src/App.vue'), file('a.css')],
      { source: ['**/*.{js,jsx,ts,tsx,vue}'] },
    );
    expect(result.map((item) => item.types)).toEqual([
      ['source'],
      ['source'],
      [],
    ]);
  });

  it('should match a root file with a **/ glob and keep the size', () => {
    const [result] = assignTypes([file('Dockerfile', 42)], {
      deployment: ['**/Dockerfile'],
    });
    expect(result).toEqual({
      path: 'Dockerfile',
      size: 42,
      types: ['deployment'],
    });
  });

  it('should order the types as the config does', () => {
    const [result] = assignTypes([file('a.md')], {
      z: ['**/*.md'],
      a: ['**/*.md'],
    });
    expect(result?.types).toEqual(['z', 'a']);
  });
});

describe('listArtifacts', () => {
  it('should list the snapshot files with sizes and types ordered by path', async () => {
    const acquisition = await createAcquisition([
      {
        fullName: 'org/a',
        files: { 'src/b.js': 'bb', 'package.json': '{}', 'logo.svg': '<svg/>' },
      },
    ]);
    const files = listArtifacts(join(acquisition.snapshot('org/a'), 'files'), {
      'dependency-manifest': ['**/package.json'],
      source: ['**/*.js'],
    });
    expect(files).toEqual([
      { path: 'logo.svg', size: 6, types: [] },
      { path: 'package.json', size: 2, types: ['dependency-manifest'] },
      { path: 'src/b.js', size: 2, types: ['source'] },
    ]);
  });
});
