BEGIN;
-- AlterTable
ALTER TABLE "asset_upload_sessions" ADD COLUMN     "vote_id" TEXT;

-- CreateTable
CREATE TABLE "exhibition_votes" (
    "id" TEXT NOT NULL,
    "exhibitionId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "guidance" TEXT NOT NULL,
    "maxSelections" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'PREPARING',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exhibition_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_posters" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_posters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_candidates" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "sourceProjectId" INTEGER,
    "title" TEXT NOT NULL,
    "posterId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "vote_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_participants" (
    "hash" TEXT NOT NULL,

    CONSTRAINT "vote_participants_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "vote_ballots" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "participantHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "vote_ballots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_selections" (
    "ballotId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "posterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "vote_selections_pkey" PRIMARY KEY ("ballotId","candidateId")
);

-- CreateTable
CREATE TABLE "vote_investigations" (
    "ballotId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "mobile" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vote_investigations_pkey" PRIMARY KEY ("ballotId")
);

-- CreateTable
CREATE TABLE "vote_changes" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" INTEGER,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voting_draw_events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "voting_draw_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voting_draw_items" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prize" BOOLEAN NOT NULL,
    "remaining" INTEGER,
    "weight" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "voting_draw_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voting_draw_changes" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "actorId" INTEGER,
    "reason" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voting_draw_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_draws" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "participantHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prize" BOOLEAN NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "calculation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_draws_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vote_receipts" (
    "id" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exhibition_votes_exhibitionId_idx" ON "exhibition_votes"("exhibitionId");

-- CreateIndex
CREATE INDEX "vote_posters_bucket_objectKey_idx" ON "vote_posters"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "vote_candidates_voteId_idx" ON "vote_candidates"("voteId");

-- CreateIndex
CREATE INDEX "vote_ballots_voteId_createdAt_id_idx" ON "vote_ballots"("voteId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vote_ballots_voteId_participantHash_key" ON "vote_ballots"("voteId", "participantHash");

-- CreateIndex
CREATE INDEX "vote_investigations_expiresAt_idx" ON "vote_investigations"("expiresAt");

-- CreateIndex
CREATE INDEX "vote_changes_voteId_createdAt_idx" ON "vote_changes"("voteId", "createdAt");

-- CreateIndex
CREATE INDEX "voting_draw_items_eventId_idx" ON "voting_draw_items"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "voting_draw_changes_eventId_version_key" ON "voting_draw_changes"("eventId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "vote_draws_eventId_participantHash_key" ON "vote_draws"("eventId", "participantHash");

-- CreateIndex
CREATE UNIQUE INDEX "vote_receipts_drawId_key" ON "vote_receipts"("drawId");

-- AddForeignKey
ALTER TABLE "exhibition_votes" ADD CONSTRAINT "exhibition_votes_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "voting_draw_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_candidates" ADD CONSTRAINT "vote_candidates_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "exhibition_votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_candidates" ADD CONSTRAINT "vote_candidates_posterId_fkey" FOREIGN KEY ("posterId") REFERENCES "vote_posters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "exhibition_votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_participantHash_fkey" FOREIGN KEY ("participantHash") REFERENCES "vote_participants"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_selections" ADD CONSTRAINT "vote_selections_ballotId_fkey" FOREIGN KEY ("ballotId") REFERENCES "vote_ballots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_selections" ADD CONSTRAINT "vote_selections_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "vote_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_selections" ADD CONSTRAINT "vote_selections_posterId_fkey" FOREIGN KEY ("posterId") REFERENCES "vote_posters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_investigations" ADD CONSTRAINT "vote_investigations_ballotId_fkey" FOREIGN KEY ("ballotId") REFERENCES "vote_ballots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_changes" ADD CONSTRAINT "vote_changes_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "exhibition_votes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voting_draw_items" ADD CONSTRAINT "voting_draw_items_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "voting_draw_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voting_draw_changes" ADD CONSTRAINT "voting_draw_changes_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "voting_draw_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_draws" ADD CONSTRAINT "vote_draws_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "voting_draw_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_draws" ADD CONSTRAINT "vote_draws_participantHash_fkey" FOREIGN KEY ("participantHash") REFERENCES "vote_participants"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vote_receipts" ADD CONSTRAINT "vote_receipts_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "vote_draws"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE exhibition_votes ADD CONSTRAINT vote_settings_valid CHECK ("maxSelections" BETWEEN 1 AND 100 AND version > 0 AND state IN ('PREPARING','OPEN','PAUSED','CLOSED') AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"));
ALTER TABLE voting_draw_events ADD CONSTRAINT draw_mode_valid CHECK (mode IN ('FINITE','WEIGHTED') AND version > 0);
ALTER TABLE voting_draw_items ADD CONSTRAINT draw_inventory_valid CHECK ((remaining IS NULL OR remaining BETWEEN 0 AND 1000000000) AND weight BETWEEN 1 AND 1000000);
ALTER TABLE vote_participants ADD CONSTRAINT participant_hash_valid CHECK (hash ~ '^[a-f0-9]{64}$');
ALTER TABLE asset_upload_sessions ADD CONSTRAINT voting_poster_kind CHECK (vote_id IS NULL OR (kind = 'POSTER' AND exhibition_id IS NOT NULL AND project_id IS NULL));
COMMIT;
