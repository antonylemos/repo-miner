import { describe, expect, it } from 'vitest';
import { findUnits } from '@/modules/mining/units.js';

const file = (path: string, types: string[]) => ({ path, size: 1, types });

describe('findUnits', () => {
  it('should list each directory that holds a marker with its marker files', () => {
    const units = findUnits(
      [
        file('shell/package.json', ['dependency-manifest']),
        file('shell/webpack.config.js', ['build-config']),
        file('header-mf/package.json', ['dependency-manifest']),
        file('header-mf/webpack.config.js', ['build-config']),
        file('products-mf/package.json', ['dependency-manifest']),
        file('products-mf/webpack.config.js', ['build-config']),
        file('shell/src/App.js', ['source']),
      ],
      ['dependency-manifest', 'build-config'],
    );
    expect(units).toEqual([
      {
        directory: 'header-mf',
        markers: ['header-mf/package.json', 'header-mf/webpack.config.js'],
      },
      {
        directory: 'products-mf',
        markers: ['products-mf/package.json', 'products-mf/webpack.config.js'],
      },
      {
        directory: 'shell',
        markers: ['shell/package.json', 'shell/webpack.config.js'],
      },
    ]);
  });

  it('should call the root of the snapshot .', () => {
    const units = findUnits(
      [file('package.json', ['dependency-manifest'])],
      ['dependency-manifest'],
    );
    expect(units).toEqual([{ directory: '.', markers: ['package.json'] }]);
  });

  it('should not list a directory that holds only source code', () => {
    const units = findUnits(
      [
        file('shell/package.json', ['dependency-manifest']),
        file('shell/src/App.js', ['source']),
        file('shell/src/index.js', ['source']),
      ],
      ['dependency-manifest'],
    );
    expect(units.map((unit) => unit.directory)).toEqual(['shell']);
  });

  it('should not count a marker of a nested directory for its parent', () => {
    const units = findUnits(
      [file('apps/web/package.json', ['dependency-manifest'])],
      ['dependency-manifest'],
    );
    expect(units.map((unit) => unit.directory)).toEqual(['apps/web']);
  });

  it('should count a file with a unit type among several types once', () => {
    const units = findUnits(
      [file('a/package.json', ['dependency-manifest', 'workspace-config'])],
      ['dependency-manifest', 'workspace-config'],
    );
    expect(units[0]?.markers).toEqual(['a/package.json']);
  });

  it('should list nothing when no file has a unit type', () => {
    expect(findUnits([file('a.js', ['source'])], ['build-config'])).toEqual([]);
  });
});
