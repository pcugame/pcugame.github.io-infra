-- Match these two names to app.env and Garage before execution.
BEGIN;
LOCK TABLE storage_buckets IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO storage_buckets (bucket, visibility, created_at, updated_at)
VALUES ('pcu-public', 'PUBLIC', now(), now()), ('pcu-protected', 'PROTECTED', now(), now())
ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF (SELECT count(*) FROM storage_buckets) <> 2
    OR NOT EXISTS (SELECT 1 FROM storage_buckets WHERE bucket = 'pcu-public' AND visibility = 'PUBLIC')
    OR NOT EXISTS (SELECT 1 FROM storage_buckets WHERE bucket = 'pcu-protected' AND visibility = 'PROTECTED')
  THEN RAISE EXCEPTION 'Bucket registry mismatch; inspect existing references, do not rename automatically';
  END IF;
END $$;
SELECT bucket, visibility FROM storage_buckets ORDER BY bucket;
COMMIT;
