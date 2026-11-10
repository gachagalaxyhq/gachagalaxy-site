-- LOCAL TEST ONLY. Mimics the parts of a Supabase project that the
-- migrations rely on. Run as the cluster superuser (supabase_admin).
create role postgres login createrole nosuperuser;          -- migration owner (not superuser)
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;                   -- PostgREST login role
grant anon, authenticated, service_role to authenticator;
grant create, connect, temporary on database postgres to postgres;
grant create, usage on schema public to postgres;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase default privileges: new public objects are exposed to API roles.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         auth.jwt() ->> 'sub'), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant select, references on auth.users to postgres;
grant execute on all functions in schema auth to postgres, anon, authenticated, service_role;
