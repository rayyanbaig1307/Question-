// Finds the local test programs (portable PostgreSQL and PostgREST) for this
// computer. The suite was first written on Windows; this keeps it working on
// Linux and macOS too. Nothing here talks to a real Supabase project.
import { resolve } from 'node:path';

export const isWindows = process.platform === 'win32';

// "postgres" on Linux/macOS, "postgres.exe" on Windows.
export const exe = name => (isWindows ? `${name}.exe` : name);

// The portable PostgreSQL 16 that npm installed for this computer.
export function postgresBin(repo) {
  const system = isWindows ? 'windows' : process.platform;
  return resolve(repo, `node_modules/@embedded-postgres/${system}-${process.arch}/native/bin`);
}

// PostgreSQL refuses to run as the "root" admin user on Linux/macOS.
export function assertNotRoot() {
  if (!isWindows && typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('PostgreSQL will not run as root. Run this test as an ordinary user (for example: su someuser -c "npm run test:concurrency").');
  }
}
