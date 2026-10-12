-- Additive, atomic; existing sessions keep diagnostics disabled. No approval/history rewrites.
BEGIN;
ALTER TABLE webgl_play_sessions
 ADD COLUMN report_hash TEXT,
 ADD COLUMN report_window_at TIMESTAMP(3),
 ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX webgl_play_sessions_report_hash_key ON webgl_play_sessions(report_hash);
CREATE TABLE webgl_connection_diagnostics (
 session_id TEXT NOT NULL REFERENCES webgl_play_sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 origin TEXT NOT NULL,
 directive TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 1,
 first_seen_at TIMESTAMP(3) NOT NULL,
 last_seen_at TIMESTAMP(3) NOT NULL,
 PRIMARY KEY (session_id, origin, directive)
);
COMMIT;
