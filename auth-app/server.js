import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createDatabase, initializeDatabase, databaseErrorMessage } from './database.js';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const deriveKey = promisify(scrypt);
const root = path.dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (user) => ({ name: user.name, email: user.email, createdAt: user.created_at });

export async function createApp({ database = createDatabase(), secureCookies = process.env.NODE_ENV === 'production', appOrigin = process.env.APP_ORIGIN } = {}) {
  try {
    await initializeDatabase(database);
  } catch (error) {
    await database.end();
    throw error;
  }
  const app = express();
  if (process.env.VERCEL) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://lepide-design-system.vercel.app'],
    styleSrc: ["'self'", 'https://lepide-design-system.vercel.app', 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://lepide-design-system.vercel.app', 'data:'],
    imgSrc: ["'self'", 'https://lepide-design-system.vercel.app', 'data:'],
    upgradeInsecureRequests: null
  } } }));
  app.use(express.json({ limit: '8kb' }));
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      const origin = request.get('origin');
      if (origin && origin !== (appOrigin || `${request.protocol}://${request.get('host')}`)) {
        return response.status(403).json({ message: 'This request is not allowed.' });
      }
      if (!request.is('application/json')) return response.status(415).json({ message: 'Send a JSON request.' });
    }
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many attempts. Try again in 15 minutes.' } });
  app.use(['/api/signup', '/api/login'], authLimit);

  async function currentSession(request) {
    const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('lepide_session='))?.slice('lepide_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await database.query('SELECT users.*, sessions.token_hash FROM public.app_sessions AS sessions JOIN public.app_users AS users ON users.id = sessions.user_id WHERE token_hash = $1 AND expires_at > $2', [digest(token), new Date().toISOString()]);
    return result.rows[0];
  }

  async function issueSession(request, response, userId, remember) {
    const previous = await currentSession(request);
    const token = randomBytes(32).toString('hex');
    const lifetime = (remember ? 30 : 1) * 24 * 60 * 60 * 1000;
    await database.query('DELETE FROM public.app_sessions WHERE expires_at <= $1', [new Date().toISOString()]);
    await database.query('INSERT INTO public.app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [digest(token), userId, new Date(Date.now() + lifetime).toISOString()]);
    if (previous) await database.query('DELETE FROM public.app_sessions WHERE token_hash = $1', [previous.token_hash]);
    response.cookie('lepide_session', token, { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', ...(remember ? { maxAge: lifetime } : {}) });
  }

  app.post('/api/signup', async (request, response) => {
    const { name, email, password } = request.body || {};
    const errors = {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) errors.name = 'Enter a name between 2 and 80 characters.';
    if (typeof email !== 'string' || email.length > 254 || !emailPattern.test(email.trim())) errors.email = 'Enter a valid email address.';
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) errors.password = 'Use between 12 and 128 characters.';
    if (Object.keys(errors).length) return response.status(400).json({ message: 'Check the highlighted fields.', errors });
    const normalizedEmail = email.trim().toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await deriveKey(password, salt, 64)).toString('hex');
    let result;
    try {
      result = await database.query('INSERT INTO public.app_users (name, email, password_hash, salt, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *', [name.trim(), normalizedEmail, passwordHash, salt, new Date().toISOString()]);
    } catch (error) {
      if (error.code === '23505') return response.status(409).json({ message: 'Unable to create an account with these details. Try signing in.' });
      throw error;
    }
    const user = result.rows[0];
    await issueSession(request, response, user.id, false);
    response.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/login', async (request, response) => {
    const { email, password, remember = false } = request.body || {};
    if (typeof email !== 'string' || email.length > 254 || !emailPattern.test(email.trim()) || typeof password !== 'string' || !password.length || password.length > 128) {
      return response.status(400).json({ message: 'Enter a valid email address and password.' });
    }
    const result = await database.query('SELECT * FROM public.app_users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    const computed = await deriveKey(password, user?.salt || 'missing-account-timing-salt', 64);
    if (!user || !timingSafeEqual(computed, Buffer.from(user.password_hash, 'hex'))) return response.status(401).json({ message: 'Email or password is incorrect.' });
    await issueSession(request, response, user.id, remember === true);
    response.json({ user: publicUser(user) });
  });

  app.get('/api/me', async (request, response) => {
    const user = await currentSession(request);
    if (!user) return response.status(401).json({ message: 'Sign in to continue.' });
    response.json({ user: publicUser(user) });
  });

  app.post('/api/logout', async (request, response) => {
    const user = await currentSession(request);
    if (user) await database.query('DELETE FROM public.app_sessions WHERE token_hash = $1', [user.token_hash]);
    response.clearCookie('lepide_session', { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/' });
    response.json({ message: 'You have been signed out.' });
  });

  app.get('/', async (request, response) => response.redirect(await currentSession(request) ? '/account' : '/login'));
  for (const screen of ['login', 'signup', 'account']) {
    app.get(`/${screen}`, async (request, response) => {
      const user = await currentSession(request);
      if (screen === 'account' && !user) return response.redirect('/login');
      if (screen !== 'account' && user) return response.redirect('/account');
      response.sendFile(path.join(root, 'public', `${screen}.html`));
    });
  }
  app.use(express.static(path.join(root, 'public'), { index: false, extensions: false }));
  app.use((error, request, response, next) => {
    if (error.status === 400) return response.status(400).json({ message: 'The request could not be read.' });
    console.error('Request failed:', error.code || 'INTERNAL_ERROR');
    response.status(500).json({ message: 'Something went wrong. Please try again.' });
  });
  app.locals.database = database;
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5180;
  try {
    const app = await createApp();
    app.listen(port, () => console.log(`Lepide is running at http://localhost:${port} using ${app.locals.database.storage}`));
  } catch (error) {
    console.error('Unable to start application:', databaseErrorMessage(error));
    process.exitCode = 1;
  }
}