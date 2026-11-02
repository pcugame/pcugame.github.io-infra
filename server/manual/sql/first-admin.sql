-- psql -v ON_ERROR_STOP=1 -v user_id=... -v google_subject=... -f first-admin.sql
-- Obtain BOTH identifiers from an authenticated user's row, then verify identity.
BEGIN;
LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;
SELECT set_config('pcu.bootstrap_user_id', :'user_id', true);
SELECT set_config('pcu.bootstrap_google_subject', :'google_subject', true);
DO $$
DECLARE changed integer;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN
    RAISE EXCEPTION 'An administrator already exists; use normal role administration';
  END IF;
  PERFORM id FROM users
    WHERE id = current_setting('pcu.bootstrap_user_id')::integer
      AND google_sub = current_setting('pcu.bootstrap_google_subject')
      AND role = 'USER'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected exactly one verified USER by ID and Google subject'; END IF;
  UPDATE users SET role = 'ADMIN', updated_at = now()
    WHERE id = current_setting('pcu.bootstrap_user_id')::integer
      AND google_sub = current_setting('pcu.bootstrap_google_subject') AND role = 'USER';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'Expected one role change, got %', changed; END IF;
END $$;
SELECT id, google_sub, email, role FROM users
WHERE id = current_setting('pcu.bootstrap_user_id')::integer;
COMMIT;
