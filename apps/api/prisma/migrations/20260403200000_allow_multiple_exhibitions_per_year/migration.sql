-- Allow multiple exhibitions per year (e.g. "졸업작품전", "강의 과제물")
-- Only prevent exact duplicate (year, title) pairs.

-- Step 1: Drop the single-column unique on year
DROP INDEX IF EXISTS "years_year_key";

-- Step 2: Add composite unique on (year, title)
ALTER TABLE "years" ADD CONSTRAINT "year_title" UNIQUE ("year", "title");
