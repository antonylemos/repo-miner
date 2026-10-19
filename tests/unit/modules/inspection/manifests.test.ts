import { describe, expect, it } from 'vitest';
import { readManifest } from '@/modules/inspection/manifests.js';

const manifest = (lines: string[]) => `${lines.join('\n')}\n`;

describe('readManifest', () => {
  it('should read a dependency and not the script that names the same package', () => {
    const text = manifest([
      '{',
      '  "name": "host",',
      '  "scripts": {',
      '    "a": "1",',
      '    "b": "2",',
      '    "c": "3",',
      '    "d": "4",',
      '    "e": "5",',
      '    "start": "ng serve @angular-architects/module-federation"',
      '  },',
      '  "dependencies": {',
      '    "@angular-architects/module-federation": "^19.0.0"',
      '  }',
      '}',
    ]);
    expect(readManifest(text)).toEqual({
      state: 'ok',
      dependencies: [
        {
          section: 'dependencies',
          name: '@angular-architects/module-federation',
          version: '^19.0.0',
          line: 12,
        },
      ],
    });
  });

  it('should give each section its own line for the same package', () => {
    const text = manifest([
      '{',
      '  "dependencies": {',
      '    "lit": "^3.0.0"',
      '  },',
      '  "peerDependencies": {',
      '    "lit": ">=2"',
      '  }',
      '}',
    ]);
    const result = readManifest(text);
    expect(result.state === 'ok' && result.dependencies).toEqual([
      { section: 'dependencies', name: 'lit', version: '^3.0.0', line: 3 },
      { section: 'peerDependencies', name: 'lit', version: '>=2', line: 6 },
    ]);
  });

  it('should read the four sections and ignore other keys', () => {
    const text = JSON.stringify(
      {
        dependencies: { a: '1' },
        devDependencies: { b: '2' },
        peerDependencies: { c: '3' },
        optionalDependencies: { d: '4' },
        bundledDependencies: { e: '5' },
        scripts: { f: '6' },
      },
      null,
      2,
    );
    const result = readManifest(text);
    expect(
      result.state === 'ok' &&
        result.dependencies.map(({ section, name }) => `${section}:${name}`),
    ).toEqual([
      'dependencies:a',
      'devDependencies:b',
      'peerDependencies:c',
      'optionalDependencies:d',
    ]);
  });

  it('should write the version as is, including protocols and ranges', () => {
    const result = readManifest(
      '{"dependencies":{"a":"workspace:*","b":"file:../shared","c":"^1.0.0 || ^2"}}',
    );
    expect(result.state === 'ok' && result.dependencies).toMatchObject([
      { version: 'workspace:*' },
      { version: 'file:../shared' },
      { version: '^1.0.0 || ^2' },
    ]);
  });

  it('should write a version that is not a string as canonical JSON', () => {
    const result = readManifest('{"dependencies":{"a":{"z":1,"b":[2]},"c":3}}');
    expect(result.state === 'ok' && result.dependencies).toMatchObject([
      { version: '{"b":[2],"z":1}' },
      { version: '3' },
    ]);
  });

  it('should give line 1 to a minified manifest', () => {
    const result = readManifest('{"dependencies":{"a":"1","b":"2"}}');
    expect(
      result.state === 'ok' && result.dependencies.map(({ line }) => line),
    ).toEqual([1, 1]);
  });

  it('should leave the line empty when no line declares the entry', () => {
    const result = readManifest(
      '{\n"dependencies": {"a": "1"},\n"x": {}\n}'.replace('"a"', '"a\\u0062"'),
    );
    expect(result.state === 'ok' && result.dependencies[0]?.line).toBeNull();
  });

  it('should count lines of a CRLF manifest', () => {
    const result = readManifest(
      '{\r\n  "dependencies": {\r\n    "a": "1"\r\n  }\r\n}\r\n',
    );
    expect(result.state === 'ok' && result.dependencies[0]?.line).toBe(3);
  });

  it('should read a manifest with a byte order mark', () => {
    const result = readManifest('﻿{"dependencies":{"a":"1"}}');
    expect(result.state).toBe('ok');
  });

  it('should ignore a section that is not an object', () => {
    expect(
      readManifest('{"dependencies":["a"],"devDependencies":"b"}'),
    ).toEqual({ state: 'ok', dependencies: [] });
  });

  it.each([
    ['a trailing comma', '{"dependencies":{"a":"1",}}'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['an empty file', ''],
  ])('should mark %s as invalid', (_name, text) => {
    expect(readManifest(text)).toEqual({ state: 'invalid' });
  });
});
