import type { DatabaseSync } from 'node:sqlite';
import type { DiscoveryStore } from '@/modules/discovery/model/store.js';

/**
 * Serves reads from one consistent view of the database. `getStore` resolves
 * the composed store lazily, because the store contains this very method.
 */
export function createReadSnapshot(
  db: DatabaseSync,
  getStore: () => DiscoveryStore,
): Pick<DiscoveryStore, 'withReadSnapshot'> {
  let snapshotActive = false;

  return {
    async withReadSnapshot(work) {
      if (snapshotActive) throw new Error('Nested snapshots are unsupported');

      db.exec('BEGIN DEFERRED');
      snapshotActive = true;
      try {
        const result = await work(getStore());
        db.exec('COMMIT');

        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        snapshotActive = false;
      }
    },
  };
}
