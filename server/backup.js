import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup } from 'node:sqlite';

// O snapshot do SQLite inclui transações confirmadas no WAL.
const source = new DatabaseSync(process.env.DB_PATH || 'data/fichapro.sqlite', { readOnly: true });
const snapshot = join(tmpdir(), 'fichapro-' + randomUUID() + '.sqlite');
process.umask(0o077);
try {
  await backup(source, snapshot);
  await pipeline(createReadStream(snapshot), process.stdout);
} finally {
  source.close();
  await rm(snapshot, { force: true });
}
