BEGIN;
CREATE TABLE IF NOT EXISTS public.app_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS public.app_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON public.app_sessions (expires_at);
CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON public.app_sessions (user_id);
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_users, public.app_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.app_users_id_seq FROM PUBLIC, anon, authenticated;
COMMIT;