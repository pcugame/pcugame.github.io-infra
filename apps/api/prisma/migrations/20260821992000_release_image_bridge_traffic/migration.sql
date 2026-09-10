-- Retain prior scopes and add explicit compatibility-route traffic authorization.
BEGIN;
ALTER TABLE "release_contract_authorizations"
  DROP CONSTRAINT "release_contract_authorizations_scope_check",
  ADD CONSTRAINT "release_contract_authorizations_scope_check"
    CHECK ("scope" IN ('24-hour-observation-age-only', '24-hour-observation-age-and-image-bridge-36', '24-hour-observation-age-and-image-bridge-traffic'));
COMMIT;
