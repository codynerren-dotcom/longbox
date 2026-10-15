ALTER TABLE "Comic" ADD COLUMN "gcdIssueId" TEXT,
ADD COLUMN "gcdSeriesId" TEXT;

CREATE INDEX "Comic_gcdIssueId_idx" ON "Comic"("gcdIssueId");
