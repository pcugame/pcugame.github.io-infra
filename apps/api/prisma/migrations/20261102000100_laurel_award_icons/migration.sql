-- Widen the existing allowlist atomically; preserve all existing icons and recipients.
BEGIN;
ALTER TABLE exhibition_awards DROP CONSTRAINT exhibition_awards_builtin_key_check;
ALTER TABLE exhibition_awards ADD CONSTRAINT exhibition_awards_builtin_key_check
 CHECK (builtin_key IS NULL OR builtin_key IN (
  'medal', 'trophy', 'ribbon',
  'laurel-gold', 'laurel-silver', 'laurel-bronze', 'laurel-slate'
 ));
COMMIT;
