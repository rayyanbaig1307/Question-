import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(new URL('../../.qa/expo/', import.meta.url), { recursive: true });
// These are deliberately fake. This bundle cannot use a real Supabase project.
const result = spawnSync(process.execPath, [
  'node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', '.qa/web',
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1',
    __UNSAFE_EXPO_HOME_DIRECTORY: fileURLToPath(new URL('../../.qa/expo/', import.meta.url)),
    EXPO_PUBLIC_SUPABASE_URL: 'https://qa-backend.invalid',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'qa-public-key-no-real-access',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
  },
});
process.exit(result.status ?? 1);
