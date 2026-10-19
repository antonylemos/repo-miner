import { join } from 'node:path';
import {
  createAcquisition,
  type FixtureRepository,
} from '@tests/mining-helpers.js';
import { temporaryDirectory } from '@tests/sampling-helpers.js';
import { mine } from '@/modules/mining/mine.js';

export const MINING_PATTERNS = [
  {
    id: 'cfg-remotes',
    artifactTypes: ['build-config'],
    regex: 'remotes\\s*[:=]',
    rationale: 'Remotes declared',
  },
  {
    id: 'cfg-plugin',
    artifactTypes: ['build-config'],
    regex: 'FederationPlugin',
    rationale: 'Plugin used',
  },
  {
    id: 'src-lifecycles',
    artifactTypes: ['source'],
    regex: 'registerApplication',
    rationale: 'Lifecycles registered',
  },
];

/** Builds an acquisition from `repositories` and mines it with a small catalog. */
export async function createMining(repositories: FixtureRepository[]) {
  const acquisition = await createAcquisition(repositories);
  const directory = join(temporaryDirectory(), 'mining');
  const config = {
    acquisition: acquisition.directory,
    version: '1',
    artifactTypes: {
      'dependency-manifest': ['**/package.json'],
      'build-config': ['**/webpack.config.js'],
      source: ['**/*.js'],
    },
    patterns: MINING_PATTERNS,
    units: { artifactTypes: ['dependency-manifest', 'build-config'] },
  };
  await mine({ config, outputDir: directory });
  return { acquisition, directory, config };
}

/** An inspection config over a mining output, with two technologies. */
export function inspectionConfig(mining: string) {
  return {
    mining,
    version: '1',
    technologies: [
      {
        id: 'tech-a',
        packages: ['^@scope/', '^plain$'],
        patterns: ['cfg-remotes', 'cfg-plugin'],
      },
      {
        id: 'tech-b',
        packages: ['^lifecycle'],
        patterns: ['src-lifecycles'],
      },
    ],
  };
}
