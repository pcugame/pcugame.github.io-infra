-- NULL preserves legacy github_url fallback; [] explicitly removes all links.
ALTER TABLE "projects" ADD COLUMN "external_links" JSONB;
