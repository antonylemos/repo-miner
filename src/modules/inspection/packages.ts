/** The directory of a `package.json` path; `.` for the one at the root. */
export function packageDirectory(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf('/');
  return slash < 0 ? '.' : manifestPath.slice(0, slash);
}

/**
 * The package of a file: the deepest of `directories` (those of the
 * `package.json` files) that contains `path`, comparing path segments (`app`
 * does not contain `app-2/x`), with `.` containing every file. Empty when no
 * directory contains it.
 */
export function packageOf(path: string, directories: string[]): string {
  let found = '';
  for (const directory of directories) {
    const contains = directory === '.' || path.startsWith(`${directory}/`);
    if (contains && directory.length > found.length) found = directory;
  }
  return found;
}
