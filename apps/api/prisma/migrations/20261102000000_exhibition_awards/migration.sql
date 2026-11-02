ALTER TABLE exhibitions ADD COLUMN awards_version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX projects_id_exhibition_id_key ON projects(id, exhibition_id);
CREATE TABLE exhibition_awards (
 id SERIAL PRIMARY KEY, exhibition_id INTEGER NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
 name TEXT NOT NULL, sort_order INTEGER NOT NULL, builtin_key TEXT, asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
 UNIQUE(id, exhibition_id), UNIQUE(exhibition_id, name),
 CHECK ((builtin_key IS NULL) <> (asset_id IS NULL)),
 CHECK (builtin_key IS NULL OR builtin_key IN ('medal','trophy','ribbon'))
);
CREATE TABLE project_awards (
 exhibition_id INTEGER NOT NULL, project_id INTEGER NOT NULL, award_id INTEGER NOT NULL,
 PRIMARY KEY(project_id, award_id),
 FOREIGN KEY(project_id, exhibition_id) REFERENCES projects(id, exhibition_id) ON DELETE CASCADE,
 FOREIGN KEY(award_id, exhibition_id) REFERENCES exhibition_awards(id, exhibition_id) ON DELETE CASCADE
);
CREATE INDEX project_awards_award_id_exhibition_id_idx ON project_awards(award_id, exhibition_id);
-- Every writer, including legacy move paths, clears awards before changing ownership.
CREATE FUNCTION clear_moved_project_awards() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.exhibition_id <> OLD.exhibition_id THEN
  DELETE FROM project_awards WHERE project_id = OLD.id;
  UPDATE exhibitions SET awards_version = awards_version + 1 WHERE id = OLD.exhibition_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_move_awards BEFORE UPDATE OF exhibition_id ON projects
FOR EACH ROW EXECUTE FUNCTION clear_moved_project_awards();
