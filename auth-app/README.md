# Lepide Authentication

Node.js + Express application using the Lepidus design contract in the parent folder. Includes signup, login, remember-me sessions, a protected account screen, and logout. No React or build step.

## Run

Requires Node.js 24.x. Authentication uses database tables only, not Supabase Auth, email confirmation, or Supabase API keys. Passwords are stored as salted hashes, never plaintext.

Keep `PORT=5180` and `APP_ORIGIN=http://localhost:5180` in the local `.env`. A blank `DATABASE_URL` selects local SQLite storage at `data/app.sqlite`. A configured but unavailable PostgreSQL database fails startup; it never silently falls back to SQLite. The `.env` file is ignored by Git and never served to browsers. Existing environment variables take precedence over it. Commit only `.env.example`, not `.env`.

## Connect Supabase Database

1. Open Supabase Dashboard > Connect > Session pooler. Copy the PostgreSQL URI and replace its password placeholder locally with your database password. Percent-encode reserved characters in the password. Copy the username, host, port, and database name exactly; the database path is normally `/postgres`. Do not share the URI or password in chat.
2. Set `DATABASE_URL` to that URI in the existing `.env`. Do not clear it to work around a failed connection unless you intentionally want a separate local SQLite database.
3. From `auth-app`, run `npm run db:setup`. This executes [supabase/schema.sql](supabase/schema.sql), creating `public.app_users`, `public.app_sessions`, indexes, and RLS restrictions. It is repeatable without deleting accounts. Use the Session pooler's administrative database credentials. Existing tables must match the documented schema; this command is not a migration engine.
4. Stop the old server with Ctrl+C and run `npm start`. Its log should include `Supabase PostgreSQL`. Open http://localhost:5180, create an account, then check Supabase Table Editor > app_users. These accounts are not listed under Supabase Authentication > Users.

Session `expires_at` and user `created_at` are PostgreSQL `timestamptz` columns. The backend sends ISO timestamps. This setup does not migrate existing SQLite users or users in the earlier `lepide_auth` schema; those tables are left untouched.

### TLS And Connection Errors

If the connection reports `SELF_SIGNED_CERT_IN_CHAIN`, download your database's public CA certificate from Supabase Dashboard > Database Settings > SSL Configuration > Download Certificate. Place it at `auth-app/supabase-ca.crt` and uncomment `DATABASE_CA_CERT_PATH=./supabase-ca.crt` in `.env`. TLS certificate and hostname verification remain enabled.

Alternatively, set `$env:NODE_EXTRA_CA_CERTS = 'C:\path\to\supabase-ca.crt'` in PowerShell before launching Node. TLS certificate and hostname verification are enabled by default; URI SSL options cannot override the application's TLS policy.

For a temporary local-development workaround, run `$env:DATABASE_TLS_SKIP_VERIFY = 'true'` before setup and startup. Traffic remains encrypted, but the database server's identity is not verified, leaving the connection vulnerable to interception. The app prints a warning and rejects the bypass in production. Remove it with `Remove-Item Env:DATABASE_TLS_SKIP_VERIFY` and restart after configuring a trusted CA. It is not saved to `.env` automatically. The legacy `DATABASE_SSL_REJECT_UNAUTHORIZED=false` setting is still supported for local development only; keep it `true` normally.

`28P01` means Supabase rejected the database credentials. `3D000` means the URI selects a database that does not exist; copy the correct URI from Connect (normally ending in `/postgres`). `42P01` means the tables are missing: run setup. Neither setup nor the connection check prints your credentials.

```sh
cd auth-app
npm install
npm run db:check
npm run db:setup
npm start
```

For Supabase, use the sequence above. For SQLite, leave `DATABASE_URL` blank and skip `db:check` and `db:setup`; local tables are created automatically. Open http://localhost:5180. If you change the port, update `APP_ORIGIN` as well. `npm run dev` enables the Node.js file watcher.

## Deploy To Vercel

1. In Vercel Project Settings, set Root Directory to `auth-app`, Framework Preset to Other, and Node.js Version to 24.x. Leave the Build Command and Output Directory overrides disabled. Do not use `npm start` as a build command. The included `vercel.json` routes requests to `api/index.js` and bundles the HTML pages and public database CA certificate.
2. Add `DATABASE_URL` in Project Settings > Environment Variables for Production (and separately for Preview if needed). Use the working Supabase Session pooler URI from your local `.env`. Your local `.env` is intentionally not committed and is not transferred to Vercel through GitHub.
3. Set `APP_ORIGIN=https://ai-supabase-delta.vercel.app` without a trailing slash, `DATABASE_SSL_REJECT_UNAUTHORIZED=true`, and `DATABASE_CA_CERT_PATH=./prod-ca-2021.crt` if this is the CA downloaded for your database. The public CA certificate is bundled; no private key is required. Remove any `DATABASE_TLS_SKIP_VERIFY` override. Vercel supplies `NODE_ENV=production`; the app uses Secure cookies. Do not copy localhost `APP_ORIGIN` or `PORT` into the production environment.
4. Ensure `npm run db:setup` has succeeded locally against the same Supabase project. Do not run schema setup on every request or deployment build. Publish the code changes and create a new Vercel deployment after saving environment variables; existing deployments do not pick up changed environment values.
5. Visit `/login` and test signup, login, and logout. If startup fails, open the deployment's Runtime Logs and find `Application initialization failed`. The log gives a secret-free database error code; never paste environment values or the full connection URI into chat.

The function initializes Express and its connection pool once per warm instance, reuses them for concurrent requests, and retries initialization after a failure. Missing `DATABASE_URL` on Vercel is a configuration error, never an attempt to write SQLite files to the deployment filesystem. Preview domains need their own matching `APP_ORIGIN` if you test authentication there.

## Verify

```sh
npm test
npm run check
npm run db:check
```

The automated tests exercise the `pg-mem` PostgreSQL emulator and SQLite, not your live Supabase database. They validate account/session flows, persistence, origin checks, and connection configuration. The emulator does not validate PostgreSQL role permissions or RLS. The connection check performs only `SELECT 1`; `db:setup` requires a configured PostgreSQL URL and intentionally changes the schema.

## Storage And Security

With `DATABASE_URL` configured, accounts and sessions persist in Supabase PostgreSQL. Setup enables RLS without public policies and revokes table and user-identity sequence privileges from PUBLIC, anon, and authenticated. Do not add public policies or grants: these tables hold sensitive password hashes and session metadata. The administrative connection is backend-only; a restricted runtime role needs deliberate grants and appropriate RLS access. Startup checks table access but never runs schema creation. Use separate migration credentials and a least-privilege runtime role before production deployment.

Passwords use Node.js scrypt with a random per-account salt. Sessions use random opaque tokens, stored only as SHA-256 hashes, with HttpOnly and SameSite=Lax cookies. Remember-me cookies expire after 30 days; other sessions expire after one day and use a browser-session cookie. Logout revokes the current session. Queries are parameterized. Authentication endpoints have IP-based rate limits, JSON-only requests and same-origin checks. Set `APP_ORIGIN` to the exact public origin for deployment; it is the allowed browser origin, not a Supabase URL. Helmet supplies security headers and a restrictive Content Security Policy. No database URI, database credentials, password hashes, or session hashes are sent to the browser.

Use HTTPS with `NODE_ENV=production` to enable Secure cookies. By default, the connection pool uses verified TLS with default and operating-system certificate authorities plus the optional Supabase CA certificate. The temporary development bypass described above must not be used in production. Rotate credentials that have been shared in chat and update `.env` locally without committing it.

Locally, the server runs as a persistent Node.js process. Vercel uses the dedicated function entry point and trusts one platform proxy hop. Each function instance has its own pool of up to five connections; monitor Supabase pooler capacity as the deployment scales. Rate limits remain in-memory per instance: use a shared rate-limit store or platform protection before a wider production rollout. Email verification, password recovery, MFA, and email delivery are not included.

## Design Fidelity

Pages load the versioned Lepidus stylesheet and behavior script from the URLs specified in the design contract. The monogram is the supplied Lepide brand asset. Custom CSS targets layout wrappers only and uses existing design tokens. Dropdown interactions are owned by `lepidus.js`; the app only listens for its change event. Light, dark, and high-contrast themes are persisted locally. Field errors retain the documented anatomy and ARIA associations. Error messages sit outside the form card to avoid nested cards.

System gap: the contract has no authentication-page composition. The application composes the documented Card, Input, Checkbox, Button, Link, Message, and Dropdown components with token-based page layout; no new `lp-*` classes or component replacements are introduced.