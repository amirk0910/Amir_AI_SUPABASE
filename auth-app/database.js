import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { getCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const environmentFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

export function createDatabase({ requirePostgres = false, sqlitePath } = {}) {
  if (!process.env.DATABASE_URL?.trim()) {
    if (requirePostgres || process.env.VERCEL) {
      throw Object.assign(new Error('DATABASE_URL is required for Supabase on Vercel.'), { code: 'DATABASE_URL_REQUIRED' });
    }
    mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
    const sqlite = new DatabaseSync(sqlitePath || fileURLToPath(new URL('./data/app.sqlite', import.meta.url)));
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON app_sessions(expires_at);
    `);
    return {
      storage: 'SQLite',
      async query(sql, values = []) {
        const statement = sqlite.prepare(sql.replace(/public\./g, '').replace(/\$\d+/g, '?'));
        try {
          if (/^SELECT\b|\bRETURNING\b/i.test(sql.trim())) return { rows: statement.all(...values) };
          statement.run(...values);
          return { rows: [] };
        } catch (error) {
          if (error.errcode === 2067) error.code = '23505';
          throw error;
        }
      },
      async end() { sqlite.close(); }
    };
  }
  const rejectUnauthorized = process.env.DATABASE_TLS_SKIP_VERIFY !== 'true' && process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  if (!rejectUnauthorized && process.env.NODE_ENV === 'production') {
    throw new Error('Database certificate verification cannot be disabled in production.');
  }
  if (!rejectUnauthorized) console.warn('Warning: database TLS certificate verification is disabled for local development.');
  const connectionUrl = new URL(process.env.DATABASE_URL.trim());
  for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connectionUrl.searchParams.delete(option);
  const database = new pg.Pool({
    connectionString: connectionUrl.toString(),
    ssl: {
      rejectUnauthorized,
      ca: [...getCACertificates('default'), ...getCACertificates('system'),
        ...(process.env.DATABASE_CA_CERT_PATH ? [readFileSync(fileURLToPath(new URL(process.env.DATABASE_CA_CERT_PATH, import.meta.url)), 'utf8')] : [])]
    },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  database.storage = 'Supabase PostgreSQL';
  database.on('error', (error) => console.error('Database connection error:', error.code || 'UNKNOWN'));
  return database;
}

export async function initializeDatabase(database) {
  await database.query('SELECT id, name, email, password_hash, salt, created_at FROM public.app_users LIMIT 0');
  await database.query('SELECT token_hash, user_id, expires_at FROM public.app_sessions LIMIT 0');
}

export function databaseErrorMessage(error) {
  const messages = {
    DATABASE_URL_REQUIRED: 'Set DATABASE_URL in Vercel Project Settings > Environment Variables and redeploy. Local .env files are not uploaded.',
    '28P01': 'Supabase rejected the database login. Check the Session pooler username and URL-encoded database password in DATABASE_URL.',
    '3D000': 'The selected database does not exist. Copy the Session pooler URI from Supabase Connect; its database path is normally /postgres.',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate verification failed. Configure the Supabase CA with DATABASE_CA_CERT_PATH or NODE_EXTRA_CA_CERTS.',
    '42P01': 'Database tables are missing. Run npm run db:setup before starting the app.',
    '42501': 'The database role lacks permission. Setup requires administrative credentials; runtime access requires appropriate grants and RLS access.'
  };
  return `${error.code || 'CONFIGURATION_ERROR'}: ${messages[error.code] || 'Check database configuration, network access, and the documented setup steps.'}`;
}