ALTER TABLE projects
  ADD COLUMN webgl_display_width INTEGER,
  ADD COLUMN webgl_display_height INTEGER,
  ADD CONSTRAINT projects_webgl_display_size_check CHECK (
    (webgl_display_width IS NULL AND webgl_display_height IS NULL)
    OR (webgl_display_width IS NOT NULL AND webgl_display_height IS NOT NULL
      AND webgl_display_width BETWEEN 1 AND 8192
      AND webgl_display_height BETWEEN 1 AND 8192)
  );
