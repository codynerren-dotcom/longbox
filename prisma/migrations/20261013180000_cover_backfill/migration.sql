ALTER TABLE "Comic" ADD COLUMN "metronIssueId" TEXT;
ALTER TABLE "Comic" ADD COLUMN "coverFile" TEXT;
ALTER TABLE "Comic" ADD COLUMN "coverStatus" TEXT;
ALTER TABLE "Comic" ADD COLUMN "coverNote" TEXT;
ALTER TABLE "Comic" ADD COLUMN "coverCheckedAt" TIMESTAMP(3);

CREATE INDEX "Comic_coverStatus_idx" ON "Comic"("coverStatus");
