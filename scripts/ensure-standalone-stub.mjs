// Pre-tauri-dev guard: writes a 0-byte placeholder at
// `src-tauri/resources/standalone.tar` when missing, so cargo's
// resource-path validator passes during the parallel BeforeDevCommand
// + DevCommand startup. BeforeDevCommand later overwrites with the
// real tarball via atomic rename. Idempotent — never overwrites an
// existing tarball.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const tarball = path.join(repo, 'src-tauri', 'resources', 'standalone.tar');

if (!existsSync(tarball)) {
  // Cargo's validator only checks `Path::exists()`, so an empty file is enough.
  writeFileSync(tarball, '');
  console.log(`ensure-standalone-stub: wrote 0-byte placeholder at ${tarball}`);
} else if (statSync(tarball).size === 0) {
  console.log(`ensure-standalone-stub: 0-byte placeholder already present at ${tarball}`);
}
// Real tarball on disk — silent no-op.
