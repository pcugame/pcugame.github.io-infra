-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('PC', 'MOBILE', 'WEB');

-- AlterTable: add github_url and platforms to projects
ALTER TABLE "projects" ADD COLUMN "github_url" TEXT NOT NULL DEFAULT '';
ALTER TABLE "projects" ADD COLUMN "platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[];
