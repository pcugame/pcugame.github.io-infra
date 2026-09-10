-- Extend explicit release authorization; preserve all existing receipts and metrics.
BEGIN;
ALTER TABLE "release_contract_authorizations"
  DROP CONSTRAINT "release_contract_authorizations_scope_check",
  ADD CONSTRAINT "release_contract_authorizations_scope_check"
    CHECK ("scope" IN ('24-hour-observation-age-only', '24-hour-observation-age-and-image-bridge-36'));
COMMIT;
