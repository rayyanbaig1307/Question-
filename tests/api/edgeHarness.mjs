import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Runs the real Deno handler, with a fake Supabase service and no network access.
export function loadEdge(name, admin, login = async () => ({ data: { session: null }, error: null }), options = {}) {
  let handler;
  const relative = `supabase/functions/${name}/index.ts`;
  const source = process.env.QA_ORIGINAL === '1'
    ? execFileSync('git', ['show', `a9e5ddf88e785bd8378b2b7d9dcd7e341df439b1:${relative}`], { encoding: 'utf8' })
    : readFileSync(resolve(relative), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'test-admin', SUPABASE_ANON_KEY: 'test-anon', ...options.env };
  vm.runInNewContext(compiled, {
    exports: {},
    require: (id) => {
      if (id.startsWith('npm:jose')) return options.jose ?? {
        importPKCS8: async () => 'test-key',
        SignJWT: class { setProtectedHeader() { return this; } setIssuer() { return this; } setSubject() { return this; } setAudience() { return this; } setIssuedAt() { return this; } setExpirationTime() { return this; } async sign() { return 'test-client-secret'; } },
        decodeJwt: (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()),
      };
      if (!id.startsWith('npm:@supabase/supabase-js')) throw new Error(`Unexpected import: ${id}`);
      return { createClient: (_url, key) => key === 'test-admin' ? admin : { auth: { signInWithPassword: login } } };
    },
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
    Response, Request, Headers, TextEncoder, TextDecoder, ReadableStream, AbortController, URLSearchParams,
    crypto: webcrypto, console, Date, setTimeout, clearTimeout,
    fetch: options.fetch ?? (() => { throw new Error('Network access forbidden in edge tests'); }),
  }, { filename: name });
  if (!handler) throw new Error('No handler registered');
  return handler;
}

export function request(body, { token, method = 'POST', headers = {} } = {}) {
  return new Request('http://127.0.0.1/test', {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

export function query(result = { data: null, error: null }) {
  const chain = {};
  for (const method of ['select', 'eq', 'gte', 'gt', 'lt', 'insert', 'delete', 'maybeSingle', 'single', 'order', 'range', 'or', 'in', 'limit', 'ilike', 'not', 'is', 'upsert', 'update']) chain[method] = () => chain;
  chain.then = (resolve, reject) => Promise.resolve(typeof result === 'function' ? result() : result).then(resolve, reject);
  return chain;
}
