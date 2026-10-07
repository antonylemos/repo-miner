import { type DiscoveryStore, openStore } from '../storage.js';
import { inspectVersion } from './connection.js';
import { openProtocolStore, type ProtocolStore } from './protocol-store.js';
/** Opens existing runs without conversion, tokens or network access. */
export function openRunStore(
  path: string,
):
  | { version: 2; store: DiscoveryStore }
  | { version: 3; store: ProtocolStore } {
  const version = inspectVersion(path);
  if (version === 2) return { version: 2, store: openStore(path) };
  if (version === 3) return { version: 3, store: openProtocolStore(path) };
  throw new Error(`Unsupported discovery database schema (version ${version})`);
}
