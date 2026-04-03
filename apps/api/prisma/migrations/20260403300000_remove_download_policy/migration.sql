-- AlterTable: remove download_policy column from projects
ALTER TABLE "projects" DROP COLUMN "download_policy";

-- DropEnum
DROP TYPE "DownloadPolicy";
