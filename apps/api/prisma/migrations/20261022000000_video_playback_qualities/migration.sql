BEGIN;
ALTER TABLE video_playback_renditions DROP CONSTRAINT video_playback_renditions_profile;
ALTER TABLE video_playback_renditions ADD CONSTRAINT video_playback_renditions_profile
 CHECK (profile IN ('native', 'cap60', 'cap30', 'legacy') OR profile ~ '^(native|cap60|cap30)@720p$');
COMMIT;
