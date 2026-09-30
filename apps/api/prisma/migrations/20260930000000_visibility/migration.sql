CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'AUTHENTICATED', 'STAFF');
ALTER TABLE "exhibitions" ADD COLUMN "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "projects" ADD COLUMN "visibility" "Visibility" NOT NULL DEFAULT 'PUBLIC';
