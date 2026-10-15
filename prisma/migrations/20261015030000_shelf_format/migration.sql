ALTER TABLE "Comic" ADD COLUMN "shelfFormat" TEXT NOT NULL DEFAULT 'single';
ALTER TABLE "Comic" ADD COLUMN "collects" TEXT;
CREATE INDEX "Comic_shelfFormat_idx" ON "Comic"("shelfFormat");
