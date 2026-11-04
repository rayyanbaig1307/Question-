import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Downloads the official PostgREST 16.5 release for this computer and checks
// its SHA-256 before unpacking it into .qa/tools/postgrest/ (a local test tool).
// The Windows checksum was pinned by the original QA run. The Linux checksum was
// recorded from the same official GitHub release (whose Windows file matched the
// original pin), so it is a first-seen pin rather than one published by PostgREST.
const releases = {
  'win32-x64': {
    file: 'postgrest-v16.5-windows-x86-64.zip',
    sha256: '17f595b0d8dd37473d0231417dea07c5ac9f791282ff5b017fae51ff29e5de2f',
  },
  'linux-x64': {
    file: 'postgrest-v16.5-linux-static-x86-64.tar.xz',
    sha256: '5099e7ada38f9f6846cd87c14c5f158b7c165f1e9959665ad412e61f4dceba95',
  },
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error(`This optional test runtime is set up for Windows x64 and Linux x64, not ${process.platform}-${process.arch}. Set QA_POSTGREST_BINARY to your own PostgREST 16.5 instead.`);

const folder = new URL('../../.qa/tools/postgrest/', import.meta.url);
await mkdir(folder, { recursive: true });
const response = await fetch(`https://github.com/PostgREST/postgrest/releases/download/v16.5/${release.file}`);
if (!response.ok) throw new Error(`Could not download test runtime: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== release.sha256) throw new Error('Test runtime checksum mismatch');
const archive = new URL(release.file, folder);
await writeFile(archive, bytes);

let result;
if (process.platform === 'win32') {
  const script = new URL('extract.ps1', folder);
  await writeFile(script, `param([string]$Archive,[string]$Target)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Archive -DestinationPath $Target -Force\n`);
  result = spawnSync('powershell.exe', ['-NoProfile', '-File', fileURLToPath(script), '-Archive', fileURLToPath(archive), '-Target', fileURLToPath(folder)], { windowsHide: true, stdio: 'inherit' });
} else {
  result = spawnSync('tar', ['-xJf', fileURLToPath(archive), '-C', fileURLToPath(folder), 'postgrest'], { stdio: 'inherit' });
  if (result.status === 0) await chmod(new URL('postgrest', folder), 0o755);
}
if (result.status !== 0) throw new Error('Could not extract test runtime');
console.log('Verified PostgREST 16.5 test runtime is ready in .qa/tools/postgrest.');
