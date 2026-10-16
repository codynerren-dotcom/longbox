-- CreateTable
CREATE TABLE "MatchProposal" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "seriesId" TEXT,
    "confidence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "coverUrl" TEXT,
    "title" TEXT NOT NULL,
    "issueNo" TEXT NOT NULL,
    "variant" TEXT,
    "priorLink" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchProposal_status_idx" ON "MatchProposal"("status");

-- CreateIndex
CREATE INDEX "MatchProposal_comicId_idx" ON "MatchProposal"("comicId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchProposal_comicId_provider_issueId_key" ON "MatchProposal"("comicId", "provider", "issueId");

-- AddForeignKey
ALTER TABLE "MatchProposal" ADD CONSTRAINT "MatchProposal_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "Comic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
