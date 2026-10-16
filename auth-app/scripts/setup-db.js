import { readFileSync } from 'node:fs';
import { createDatabase, initializeDatabase, databaseErrorMessage } from '../database.js';

let database;
try {
  database = createDatabase({ requirePostgres: true });
  await database.query(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await initializeDatabase(database);
  console.log('Supabase PostgreSQL setup complete: public.app_users and public.app_sessions are ready.');
} catch (error) {
  console.error('Database setup failed:', databaseErrorMessage(error));
  process.exitCode = 1;
} finally {
  await database?.end();
}