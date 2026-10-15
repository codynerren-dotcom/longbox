-- CreateTable
CREATE TABLE "SearchQueue" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "resumeAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchQueue_resumeAt_idx" ON "SearchQueue"("resumeAt");

-- CreateIndex
CREATE UNIQUE INDEX "SearchQueue_comicId_source_key" ON "SearchQueue"("comicId", "source");

-- AddForeignKey
ALTER TABLE "SearchQueue" ADD CONSTRAINT "SearchQueue_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "Comic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
