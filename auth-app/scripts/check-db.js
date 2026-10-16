import { createDatabase, databaseErrorMessage } from '../database.js';

let database;
try {
  database = createDatabase({ requirePostgres: true });
  await database.query('SELECT 1');
  console.log(database.options.ssl.rejectUnauthorized === false
    ? 'Supabase PostgreSQL connection successful with encrypted TLS; certificate verification disabled.'
    : 'Supabase PostgreSQL connection verified with TLS.');
} catch (error) {
  console.error('Database connection failed:', databaseErrorMessage(error));
  process.exitCode = 1;
} finally {
  await database?.end();
}