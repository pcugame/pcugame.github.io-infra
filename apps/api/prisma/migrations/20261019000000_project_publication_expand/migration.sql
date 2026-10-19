BEGIN;
CREATE TYPE "PublicationStatus" AS ENUM ('PRIVATE', 'PUBLIC');
ALTER TABLE projects
 ADD COLUMN publication_status "PublicationStatus" NOT NULL DEFAULT 'PRIVATE',
 ADD COLUMN publication_requested_version integer,
 ADD COLUMN publication_requested boolean NOT NULL DEFAULT false,
 ADD COLUMN publication_exception_reason text,
 ADD COLUMN publication_actor_id integer,
 ADD COLUMN legacy_publication boolean NOT NULL DEFAULT false,
 ADD COLUMN hidden_cancelled boolean NOT NULL DEFAULT false;
CREATE TABLE publication_exceptions (
 id text PRIMARY KEY, project_id integer NOT NULL, actor_id integer,
 reason text NOT NULL, kind text NOT NULL, project_version integer NOT NULL,
 waived_items text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_exceptions_project_id_idx ON publication_exceptions(project_id);
UPDATE projects SET publication_status = 'PUBLIC', legacy_publication = true
 WHERE status IN ('PUBLISHED', 'ARCHIVED') AND visibility <> 'STAFF';
INSERT INTO publication_exceptions(id, project_id, reason, kind, project_version, waived_items)
 SELECT 'legacy-' || id, id, 'Existing publication preserved at migration', 'LEGACY', version, ARRAY[]::text[]
 FROM projects WHERE legacy_publication;
UPDATE projects SET hidden_cancelled = true WHERE status = 'DRAFT' AND EXISTS (
 SELECT 1 FROM project_submissions s WHERE s.project_id = projects.id AND s.state = 'CANCELLED'
);
CREATE INDEX projects_publication_status_idx ON projects(publication_status);
COMMIT;
