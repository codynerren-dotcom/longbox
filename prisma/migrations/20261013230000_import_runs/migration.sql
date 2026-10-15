-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "rows" INTEGER NOT NULL,
    "uniqueCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "updatedCount" INTEGER NOT NULL,
    "collapsed" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);
