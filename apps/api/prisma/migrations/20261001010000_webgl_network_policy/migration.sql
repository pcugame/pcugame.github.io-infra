-- Additive rollout; old applications retain local-only session snapshots.
-- Transactional DDL makes the new policy, review history and uniqueness atomic.
BEGIN;
ALTER TABLE "projects" ADD COLUMN "webgl_network_policy_version" INTEGER NOT NULL DEFAULT 0;
CREATE TYPE "WebglNetworkRequestState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
CREATE TYPE "WebglNetworkMode" AS ENUM ('HTTPS', 'WSS');
CREATE TABLE "webgl_network_requests" (
 "id" TEXT PRIMARY KEY, "project_id" INTEGER REFERENCES "projects"("id") ON DELETE SET NULL,
 "original_project_id" INTEGER NOT NULL, "project_title" TEXT NOT NULL, "requester_id" INTEGER NOT NULL,
 "origin" TEXT NOT NULL, "purpose" TEXT NOT NULL, "mode" "WebglNetworkMode" NOT NULL, "cors" TEXT NOT NULL,
 "state" "WebglNetworkRequestState" NOT NULL DEFAULT 'PENDING', "reviewer_id" INTEGER, "review_reason" TEXT,
 "policy_version" INTEGER, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "reviewed_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "webgl_network_requests_active_origin_key" ON "webgl_network_requests"("project_id", "origin")
 WHERE "state" IN ('PENDING', 'APPROVED');
CREATE INDEX "webgl_network_requests_state_created_at_idx" ON "webgl_network_requests"("state", "created_at");
CREATE INDEX "webgl_network_requests_original_project_id_created_at_idx" ON "webgl_network_requests"("original_project_id", "created_at");
CREATE TABLE "webgl_network_review_events" (
 "id" TEXT PRIMARY KEY, "request_id" TEXT NOT NULL REFERENCES "webgl_network_requests"("id") ON DELETE RESTRICT,
 "original_project_id" INTEGER NOT NULL, "origin" TEXT NOT NULL, "action" TEXT NOT NULL,
 "actor_id" INTEGER NOT NULL, "reason" TEXT NOT NULL, "policy_version" INTEGER,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "webgl_network_review_action" CHECK ("action" IN ('APPROVE', 'REJECT', 'REVOKE')),
 CONSTRAINT "webgl_network_review_version" CHECK (("action" = 'REJECT' AND "policy_version" IS NOT NULL AND "policy_version" >= 0)
  OR ("action" IN ('APPROVE', 'REVOKE') AND "policy_version" IS NOT NULL AND "policy_version" > 0))
);
CREATE INDEX "webgl_network_review_events_original_project_id_action_policy_version_idx"
 ON "webgl_network_review_events"("original_project_id", "action", "policy_version");
-- History cannot be edited or deleted by ordinary application writes.
CREATE FUNCTION reject_webgl_network_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'WebGL network review history is append-only';
END;
$$;
CREATE TRIGGER "webgl_network_review_append_only" BEFORE UPDATE OR DELETE ON "webgl_network_review_events"
 FOR EACH ROW EXECUTE FUNCTION reject_webgl_network_review_mutation();
COMMIT;
