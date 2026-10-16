import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDb } from 'pg-mem';
import { createApp } from '../server.js';
import { createDatabase, databaseErrorMessage } from '../database.js';

function createTestDatabase(memory = newDb({ noAstCoverageCheck: true })) {
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const ready = pool.query(schema.replace(/ALTER TABLE [^;]+ ENABLE ROW LEVEL SECURITY;|REVOKE [^;]+;/g, ''));
  return {
    query: async (sql, values) => { await ready; return pool.query(sql, values); },
    end: () => pool.end()
  };
}

function createTestSqliteDatabase() {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = '';
  try {
    return createDatabase({ sqlitePath: ':memory:' });
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
}

async function verifyAuthentication(context, database) {
  const app = await createApp({ database, secureCookies: false });
  const server = app.listen(0);
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await app.locals.database.end(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${server.address().port}`;
  const post = (route, body, cookie = '', extraHeaders = {}) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders }, body: JSON.stringify(body) });
  const account = { name: 'Alex Morgan', email: 'Alex@example.com', password: 'a-long-test-password' };
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  assert.equal((await post('signup', { ...account, password: 'short' })).status, 400);
  assert.equal((await post('signup', account, '', { Origin: 'https://untrusted.example' })).status, 403);
  const signup = await post('signup', account);
  assert.equal(signup.status, 201);
  assert.equal((await signup.json()).user.email, 'alex@example.com');
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  assert.match(signup.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(signup.headers.get('set-cookie'), /SameSite=Lax/i);
  const stored = (await app.locals.database.query('SELECT * FROM public.app_users')).rows[0];
  assert.notEqual(stored.password_hash, account.password);
  assert.equal(stored.password_hash.length, 128);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await post('signup', account)).status, 409);
  assert.equal((await post('login', { ...account, password: 'incorrect' })).status, 401);
  const login = await post('login', { ...account, remember: true }, cookie);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Max-Age=2592000/);
  const newCookie = login.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, cookie);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await post('logout', {}, newCookie)).status, 200);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: newCookie } })).status, 401);
  const nextLogin = await post('login', account);
  const nextCookie = nextLogin.headers.get('set-cookie').split(';')[0];
  await app.locals.database.query('UPDATE public.app_sessions SET expires_at = $1', ['2000-01-01T00:00:00.000Z']);
  assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: nextCookie } })).status, 401);
  assert.equal((await fetch(`${base}/account`, { redirect: 'manual' })).status, 302);
}

test('PostgreSQL: signup, login, session rotation, expiry and logout', (context) => verifyAuthentication(context, createTestDatabase()));
test('SQLite: signup, login, session rotation, expiry and logout', (context) => verifyAuthentication(context, createTestSqliteDatabase()));

test('configured database failures abort startup instead of falling back', async () => {
  let closed = false;
  const error = Object.assign(new Error('probe connection failure'), { code: '28P01' });
  await assert.rejects(createApp({ database: {
    query: async () => { throw error; },
    end: async () => { closed = true; }
  } }), { code: '28P01' });
  assert.equal(closed, true);
  assert.match(databaseErrorMessage(error), /Session pooler username/);
});

test('repeating the setup schema preserves existing accounts', async (context) => {
  const database = createTestDatabase();
  context.after(() => database.end());
  await database.query('INSERT INTO public.app_users (name, email, password_hash, salt, created_at) VALUES ($1, $2, $3, $4, $5)', ['Setup User', 'setup@example.com', 'hash', 'salt', new Date().toISOString()]);
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await database.query(schema.replace(/ALTER TABLE [^;]+ ENABLE ROW LEVEL SECURITY;|REVOKE [^;]+;/g, ''));
  assert.equal((await database.query('SELECT COUNT(*) AS total FROM public.app_users')).rows[0].total, 1);
});

test('explicit application origin accepts HTTPS termination and rejects other origins', async (context) => {
  const app = await createApp({ database: createTestDatabase(), appOrigin: 'https://app.example.com' });
  const server = app.listen(0);
  context.after(async () => { await new Promise((resolve) => server.close(resolve)); await app.locals.database.end(); });
  await new Promise((resolve) => server.once('listening', resolve));
  const post = (origin) => fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}'
  });
  assert.equal((await post('https://app.example.com')).status, 400);
  assert.equal((await post('https://untrusted.example')).status, 403);
});

test('accounts and sessions survive restarting the server', async (context) => {
  const memory = newDb({ noAstCoverageCheck: true });
  let app = await createApp({ database: createTestDatabase(memory), secureCookies: false });
  let server = app.listen(0);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.database.end();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const signup = await fetch(`http://localhost:${server.address().port}/api/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Persistent User', email: 'persistent@example.com', password: 'persistent-test-password' })
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  await new Promise((resolve) => server.close(resolve));
  await app.locals.database.end();
  app = await createApp({ database: createTestDatabase(memory), secureCookies: false });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const profile = await fetch(`http://localhost:${server.address().port}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.name, 'Persistent User');
});

test('database certificate bypass is explicit and prohibited in production', async (context) => {
  const originalMode = process.env.NODE_ENV;
  const originalVerification = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  const originalUrl = process.env.DATABASE_URL;
  const originalSkip = process.env.DATABASE_TLS_SKIP_VERIFY;
  context.after(() => {
    for (const [key, value] of Object.entries({ NODE_ENV: originalMode, DATABASE_SSL_REJECT_UNAUTHORIZED: originalVerification, DATABASE_URL: originalUrl, DATABASE_TLS_SKIP_VERIFY: originalSkip })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.DATABASE_TLS_SKIP_VERIFY;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?sslmode=no-verify';
  process.env.NODE_ENV = 'development';
  delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  const verified = createDatabase();
  assert.equal(verified.options.ssl.rejectUnauthorized, true);
  assert.ok(!verified.options.connectionString.includes('sslmode'));
  await verified.end();
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
  const bypassed = createDatabase();
  assert.equal(bypassed.options.ssl.rejectUnauthorized, false);
  await bypassed.end();
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'true';
  process.env.DATABASE_TLS_SKIP_VERIFY = 'true';
  const temporary = createDatabase();
  assert.equal(temporary.options.ssl.rejectUnauthorized, false);
  await temporary.end();
  process.env.NODE_ENV = 'production';
  assert.throws(() => createDatabase(), /cannot be disabled in production/);
});

test('pages use documented Lepidus classes and layout tokens', () => {
  const contract = readFileSync(new URL('../../design.md', import.meta.url), 'utf8');
  const legalClasses = new Set([...contract.matchAll(/`(lp-[\w-]+)`/g)].map((match) => match[1]));
  for (const screen of ['login', 'signup', 'account']) {
    const html = readFileSync(new URL(`../public/${screen}.html`, import.meta.url), 'utf8');
    for (const match of html.matchAll(/class="([^"]+)"/g)) {
      for (const className of match[1].split(/\s+/).filter((name) => name.startsWith('lp-'))) {
        assert.ok(legalClasses.has(className), `${screen}: undocumented class ${className}`);
      }
    }
    assert.ok(html.includes('https://lepide-design-system.vercel.app/v1/lepidus.css'));
    assert.ok(html.includes('https://lepide-design-system.vercel.app/v1/lepidus.js'));
    assert.ok(!html.includes('<select'));
    assert.ok(html.includes('data-lp-dropdown="single"'));
    assert.ok(html.includes('<html lang="en" data-theme="light">'));
  }
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.lp-|#[\da-f]{3,8}\b|\b\d+px\b/i);
  for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(contract.includes(`\`${match[1]}\``), `Undocumented token ${match[1]}`);
  }
});