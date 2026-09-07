-- Run as database owner BEFORE deploying Chat v2. Non-destructive, repeatable.
BEGIN;
ALTER TABLE titsbot.chat_tests ADD COLUMN IF NOT EXISTS reserved_until double precision;
ALTER TABLE titsbot.chat_tests ADD COLUMN IF NOT EXISTS analysis_deadline double precision;
ALTER TABLE titsbot.chat_tests DROP CONSTRAINT IF EXISTS chat_tests_status_check;
ALTER TABLE titsbot.chat_tests ADD CONSTRAINT chat_tests_status_check CHECK(status IN ('RESERVED','RUNNING','ANALYZING','DONE','CANCELLED','ANALYSIS_FAILED'));
-- Do not touch completed calibrations, scores, config snapshots or analyses.
UPDATE titsbot.chat_tests SET reserved_until=created_at+30 WHERE status='RESERVED' AND reserved_until IS NULL;
UPDATE titsbot.chat_tests SET analysis_deadline=extract(epoch from clock_timestamp())+120 WHERE status='ANALYZING' AND analysis_deadline IS NULL;
-- Old pending analyses are rebuilt from preserved original messages by Chat v2.
INSERT INTO titsbot.runtime(key,value) VALUES('chat_method_schema','2') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
COMMIT;
