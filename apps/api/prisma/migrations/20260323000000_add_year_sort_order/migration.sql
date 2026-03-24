-- AlterTable: add sort_order to years (default 0 for existing rows)
ALTER TABLE "years" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "years_sort_order_year_idx" ON "years"("sort_order", "year");
