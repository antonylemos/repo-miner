import { describe, expect, it } from 'vitest';
import { parseMiningConfig } from '@/modules/mining/config.js';

const valid = {
  acquisition: 'data/acquisitions/a',
  version: '1',
  artifactTypes: {
    'dependency-manifest': ['**/package.json'],
    'build-config': ['**/webpack.config.*'],
    deployment: ['**/Dockerfile'],
  },
  patterns: [
    {
      id: 'cfg-remotes',
      artifactTypes: ['build-config'],
      regex: 'remotes\\s*[:=]',
      rationale: 'Remote units declared',
    },
    {
      id: 'ops-dockerfile',
      artifactTypes: ['deployment'],
      rationale: 'Container build definition',
    },
  ],
  units: { artifactTypes: ['dependency-manifest', 'build-config'] },
};

describe('parseMiningConfig', () => {
  it('should read a full config and compile the regular expressions', () => {
    const config = parseMiningConfig(valid);
    expect(config.acquisition).toBe('data/acquisitions/a');
    expect(config.version).toBe('1');
    expect(config.artifactTypes['build-config']).toEqual([
      '**/webpack.config.*',
    ]);
    expect(config.units.artifactTypes).toEqual([
      'dependency-manifest',
      'build-config',
    ]);
    expect(config.patterns[0]?.regex?.test('remotes: {')).toBe(true);
    expect(config.patterns[1]?.regex).toBeNull();
  });

  it('should accept ids that no code knows', () => {
    const config = parseMiningConfig({
      ...valid,
      artifactTypes: { 'ci-workflow': ['.github/workflows/*.yml'] },
      patterns: [
        {
          id: 'cfg-remotes',
          artifactTypes: ['ci-workflow'],
          regex: 'uses:',
          rationale: 'Actions used',
        },
      ],
      units: { artifactTypes: ['ci-workflow'] },
    });
    expect(config.patterns.map((pattern) => pattern.id)).toEqual([
      'cfg-remotes',
    ]);
  });

  it('should compile without the global flag so that test keeps no state', () => {
    const regex = parseMiningConfig(valid).patterns[0]?.regex as RegExp;
    expect(regex.global).toBe(false);
    expect(regex.test('remotes: a')).toBe(true);
    expect(regex.test('remotes: a')).toBe(true);
  });

  it('should compile with the i flag only when ignoreCase is true', () => {
    const config = parseMiningConfig({
      ...valid,
      patterns: [
        {
          id: 'mfe',
          artifactTypes: ['deployment'],
          regex: 'micro-?frontends?',
          ignoreCase: true,
          rationale: 'Term',
        },
        {
          id: 'exact',
          artifactTypes: ['deployment'],
          regex: 'micro-?frontends?',
          ignoreCase: false,
          rationale: 'Term',
        },
      ],
    });
    expect(config.patterns[0]?.regex?.test('Micro-Frontends')).toBe(true);
    expect(config.patterns[1]?.regex?.test('Micro-Frontends')).toBe(false);
  });

  it('should reject a field that does not exist', () => {
    expect(() => parseMiningConfig({ ...valid, filters: [] })).toThrow(
      /unknown config field filters/,
    );
  });

  it('should reject an unknown field of a pattern', () => {
    const patterns = [{ ...valid.patterns[0], flags: 'g' }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /unknown patterns\[0\] field flags/,
    );
  });

  it.each(['acquisition', 'version', 'artifactTypes', 'patterns', 'units'])(
    'should reject a config without %s',
    (field) => {
      const { [field as keyof typeof valid]: _removed, ...rest } = valid;
      expect(() => parseMiningConfig(rest)).toThrow(/Invalid mining config/);
    },
  );

  it('should name the missing version', () => {
    const { version: _version, ...rest } = valid;
    expect(() => parseMiningConfig(rest)).toThrow(/version/);
  });

  it.each([
    ['empty version', { version: '' }],
    ['numeric version', { version: 1 }],
    ['artifactTypes as array', { artifactTypes: [] }],
    ['globs as text', { artifactTypes: { a: '**/*.js' } }],
    ['patterns as object', { patterns: {} }],
    ['units as array', { units: [] }],
    ['unit types as text', { units: { artifactTypes: 'build-config' } }],
    ['unknown field of units', { units: { artifactTypes: [], more: [] } }],
  ])('should reject %s', (_name, override) => {
    expect(() => parseMiningConfig({ ...valid, ...override })).toThrow(
      /Invalid mining config/,
    );
  });

  it('should reject a non-object config', () => {
    expect(() => parseMiningConfig([])).toThrow(/expected an object/);
  });

  it('should reject a repeated pattern id', () => {
    const patterns = [valid.patterns[0], valid.patterns[0]];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /duplicate pattern id cfg-remotes/,
    );
  });

  it('should reject an artifact type that is not defined', () => {
    const patterns = [{ ...valid.patterns[0], artifactTypes: ['build-cfg'] }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /pattern cfg-remotes uses the undefined artifact type build-cfg/,
    );
  });

  it('should reject a unit type that is not defined', () => {
    expect(() =>
      parseMiningConfig({ ...valid, units: { artifactTypes: ['lockfile'] } }),
    ).toThrow(/units uses the undefined artifact type lockfile/);
  });

  it('should reject a pattern without artifact types', () => {
    const patterns = [{ ...valid.patterns[0], artifactTypes: [] }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /pattern cfg-remotes artifactTypes must not be empty/,
    );
  });

  it('should reject an invalid regular expression', () => {
    const patterns = [{ ...valid.patterns[0], regex: 'remotes(' }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /pattern cfg-remotes has the invalid regex remotes\(/,
    );
  });

  it('should reject a pattern without rationale', () => {
    const patterns = [{ ...valid.patterns[0], rationale: '' }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /rationale/,
    );
  });

  it('should reject an ignoreCase that is not a boolean', () => {
    const patterns = [{ ...valid.patterns[0], ignoreCase: 'yes' }];
    expect(() => parseMiningConfig({ ...valid, patterns })).toThrow(
      /ignoreCase must be a boolean/,
    );
  });
});
