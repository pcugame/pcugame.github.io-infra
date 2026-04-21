-- Sliding session refresh: track last activity timestamp per session.
ALTER TABLE "auth_sessions" ADD COLUMN "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
