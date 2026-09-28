CREATE TYPE "BannedIpSource" AS ENUM ('AUTO', 'MANUAL', 'LEGACY');
ALTER TABLE "banned_ips"
  ADD COLUMN "source" "BannedIpSource" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "disabled_at" TIMESTAMP(3);
-- Match only exact reasons emitted by historical application code.
UPDATE "banned_ips"
SET "source" = 'AUTO', "disabled_at" = CURRENT_TIMESTAMP
WHERE "reason" IN (
  'Rate limit exceeded (game download)',
  'Rate limit exceeded (protected asset download)',
  'Protected download IP abuse ceiling exceeded'
);
