-- Existing draft rows become published before the enum is recreated without DRAFT.
UPDATE "projects"
SET "status" = 'PUBLISHED'
WHERE "status"::text NOT IN ('PUBLISHED', 'ARCHIVED');

ALTER TABLE "projects" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "ProjectStatus_new" AS ENUM ('PUBLISHED', 'ARCHIVED');

ALTER TABLE "projects"
ALTER COLUMN "status" TYPE "ProjectStatus_new"
USING (
	CASE
		WHEN "status"::text IN ('PUBLISHED', 'ARCHIVED') THEN "status"::text
		ELSE 'PUBLISHED'
	END
)::"ProjectStatus_new";

DROP TYPE "ProjectStatus";
ALTER TYPE "ProjectStatus_new" RENAME TO "ProjectStatus";

ALTER TABLE "projects" ALTER COLUMN "status" SET DEFAULT 'PUBLISHED';
