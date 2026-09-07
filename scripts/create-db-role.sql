-- Run in Supabase SQL Editor as postgres AFTER 001_initial.sql.
-- Replace the example password locally; never save the real password in Git.
CREATE ROLE titsbot_app LOGIN PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD';
GRANT CONNECT ON DATABASE postgres TO titsbot_app;
GRANT USAGE ON SCHEMA titsbot TO titsbot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA titsbot TO titsbot_app;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='titsbot' LOOP
  EXECUTE format('CREATE POLICY server_only ON titsbot.%I FOR ALL TO titsbot_app USING (true) WITH CHECK (true)', t.tablename);
 END LOOP;
END $$;
-- Do NOT grant postgres, superuser, schema ownership or BYPASSRLS to this role.
