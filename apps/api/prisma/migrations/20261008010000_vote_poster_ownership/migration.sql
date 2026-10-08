BEGIN;
-- Nullable ownership preserves existing immutable poster references. Both
-- migrations precede the first feature release; no object copy or deletion.
ALTER TABLE vote_posters ADD COLUMN "voteId" TEXT;
ALTER TABLE vote_posters ADD CONSTRAINT "vote_posters_voteId_fkey"
  FOREIGN KEY ("voteId") REFERENCES exhibition_votes(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "vote_posters_voteId_idx" ON vote_posters("voteId");
COMMIT;
