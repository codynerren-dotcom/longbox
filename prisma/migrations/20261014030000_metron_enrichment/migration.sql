ALTER TABLE "Comic" ADD COLUMN "metronSeriesId" TEXT,
ADD COLUMN "writer" TEXT,
ADD COLUMN "artist" TEXT,
ADD COLUMN "coverArtist" TEXT,
ADD COLUMN "characters" TEXT,
ADD COLUMN "teams" TEXT,
ADD COLUMN "seriesYear" INTEGER,
ADD COLUMN "seriesVolume" INTEGER,
ADD COLUMN "fieldSources" JSONB;

CREATE INDEX "Comic_metronIssueId_idx" ON "Comic"("metronIssueId");
