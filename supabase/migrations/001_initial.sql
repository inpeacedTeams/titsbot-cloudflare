-- Apply once, as the database owner, to a NEW database/project.
BEGIN;
CREATE SCHEMA IF NOT EXISTS titsbot;
REVOKE ALL ON SCHEMA titsbot FROM PUBLIC;
CREATE TABLE titsbot.users (
 chat_id bigint NOT NULL, user_id bigint NOT NULL CHECK(user_id>0), config jsonb NOT NULL,
 calibration_status text NOT NULL DEFAULT 'NOT_STARTED',
 initial_chat_score double precision CHECK(initial_chat_score BETWEEN 0 AND 100),
 initial_mt_score double precision CHECK(initial_mt_score BETWEEN 0 AND 100),
 initial_chat_d integer CHECK(initial_chat_d BETWEEN 1 AND 10),
 initial_mt_d integer CHECK(initial_mt_d BETWEEN 1 AND 10),
 initial_final_d double precision, initial_score double precision, tag text,
 calibration_completed_at double precision, chat_snapshot jsonb, mt_snapshot jsonb,
 tag_status text NOT NULL DEFAULT 'NOT_READY', PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE titsbot.chat_tests (
 test_id text PRIMARY KEY, chat_id bigint NOT NULL, user_id bigint NOT NULL,
 status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','RUNNING','ANALYZING','DONE')),
 created_at double precision NOT NULL, started_at double precision, ended_at double precision,
 go_message_id bigint, metrics jsonb, components jsonb, score double precision,
 UNIQUE(chat_id,user_id), FOREIGN KEY(chat_id,user_id) REFERENCES titsbot.users
);
CREATE UNIQUE INDEX one_chat_active ON titsbot.chat_tests(chat_id) WHERE status IN ('RESERVED','RUNNING');
CREATE TABLE titsbot.chat_messages (
 test_id text NOT NULL REFERENCES titsbot.chat_tests, message_id bigint NOT NULL,
 timestamp double precision NOT NULL, received_at double precision NOT NULL,
 text text NOT NULL, exclusion text, edited_seen boolean NOT NULL DEFAULT false,
 PRIMARY KEY(test_id,message_id)
);
CREATE TABLE titsbot.mt_attempts (
 attempt_id text PRIMARY KEY, chat_id bigint NOT NULL, user_id bigint NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3), request_id text NOT NULL,
 status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','DONE','INVALID','EXPIRED')),
 prompt text NOT NULL, started_at double precision NOT NULL, ended_at double precision NOT NULL,
 last_seq integer NOT NULL DEFAULT -1, metrics jsonb, score double precision CHECK(score BETWEEN 0 AND 100), invalid_reason text,
 UNIQUE(chat_id,user_id,ordinal), UNIQUE(chat_id,user_id,request_id),
 FOREIGN KEY(chat_id,user_id) REFERENCES titsbot.users
);
CREATE UNIQUE INDEX one_mt_active ON titsbot.mt_attempts(chat_id,user_id) WHERE status='RUNNING';
CREATE TABLE titsbot.mt_batches (
 attempt_id text NOT NULL REFERENCES titsbot.mt_attempts, seq integer NOT NULL CHECK(seq>=0),
 payload_hash text NOT NULL, events jsonb NOT NULL, received_at double precision NOT NULL,
 PRIMARY KEY(attempt_id,seq)
);
CREATE TABLE titsbot.launch_tokens (
 token_hash text PRIMARY KEY, chat_id bigint NOT NULL,user_id bigint NOT NULL,expires_at double precision NOT NULL,
 FOREIGN KEY(chat_id,user_id) REFERENCES titsbot.users
);
CREATE INDEX launch_expiry ON titsbot.launch_tokens(expires_at);
CREATE TABLE titsbot.analysis (
 test_id text PRIMARY KEY REFERENCES titsbot.chat_tests, result jsonb NOT NULL, created_at double precision NOT NULL
);
CREATE TABLE titsbot.outbox (
 job_key text PRIMARY KEY,chat_id bigint NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,
 next_run double precision NOT NULL DEFAULT 0,lease_token text,lease_until double precision NOT NULL DEFAULT 0,last_error text
);
CREATE INDEX outbox_due ON titsbot.outbox(chat_id,next_run) WHERE status='PENDING';
CREATE TABLE titsbot.processed_updates (update_id bigint PRIMARY KEY,created_at double precision NOT NULL);
CREATE TABLE titsbot.runtime (key text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE titsbot.rate_limits (key text PRIMARY KEY,window_start bigint NOT NULL,hits integer NOT NULL);
CREATE FUNCTION titsbot.protect_user() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE k text; oldj jsonb; newj jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Calibration identities cannot be deleted'; END IF;
 IF NEW.chat_id<>OLD.chat_id OR NEW.user_id<>OLD.user_id OR NEW.config IS DISTINCT FROM OLD.config THEN RAISE EXCEPTION 'Identity/config is immutable'; END IF;
 oldj=to_jsonb(OLD);newj=to_jsonb(NEW);
 FOREACH k IN ARRAY ARRAY['initial_chat_score','initial_mt_score','initial_chat_d','initial_mt_d','initial_final_d','initial_score','tag','calibration_completed_at','chat_snapshot','mt_snapshot'] LOOP
  IF oldj->k <> 'null'::jsonb AND oldj->k IS DISTINCT FROM newj->k THEN RAISE EXCEPTION 'Initial calibration is immutable: %',k; END IF;
 END LOOP;
 IF OLD.calibration_status='CALIBRATION_COMPLETED' AND NEW.calibration_status<>OLD.calibration_status THEN RAISE EXCEPTION 'Completed calibration is immutable'; END IF;
 IF NEW.calibration_status='CALIBRATION_COMPLETED' AND (NEW.initial_chat_d IS NULL OR NEW.initial_mt_d IS NULL OR NEW.calibration_completed_at IS NULL OR NEW.initial_final_d IS NULL OR NEW.initial_final_d<>(NEW.initial_chat_d+NEW.initial_mt_d)/2.0 OR NEW.tag IS NULL) THEN RAISE EXCEPTION 'Incomplete final tier'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_user BEFORE UPDATE OR DELETE ON titsbot.users FOR EACH ROW EXECUTE FUNCTION titsbot.protect_user();
CREATE FUNCTION titsbot.protect_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attempts cannot be deleted'; END IF;
 IF OLD.status IN ('DONE','INVALID','EXPIRED') THEN RAISE EXCEPTION 'Completed attempt is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_chat BEFORE UPDATE OR DELETE ON titsbot.chat_tests FOR EACH ROW EXECUTE FUNCTION titsbot.protect_attempt();
CREATE TRIGGER protect_mt BEFORE UPDATE OR DELETE ON titsbot.mt_attempts FOR EACH ROW EXECUTE FUNCTION titsbot.protect_attempt();
CREATE FUNCTION titsbot.protect_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Analysis is immutable'; END $$;
CREATE TRIGGER protect_analysis BEFORE UPDATE OR DELETE ON titsbot.analysis FOR EACH ROW EXECUTE FUNCTION titsbot.protect_analysis();
-- No browser access, no anonymous RLS policies, no Supabase service key in the app.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='titsbot' LOOP
  EXECUTE format('ALTER TABLE titsbot.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA titsbot FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA titsbot FROM PUBLIC;
INSERT INTO titsbot.runtime VALUES('schema_version','1');
COMMIT;
-- Configure a dedicated server login separately with scripts/create-db-role.sql.
