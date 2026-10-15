-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Comic" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "coreComicId" TEXT,
    "coreSeriesId" TEXT,
    "clzIndex" TEXT,
    "series" TEXT NOT NULL,
    "seriesSort" TEXT NOT NULL,
    "issue" TEXT,
    "issueNo" TEXT,
    "issueSort" INTEGER,
    "variantDescription" TEXT,
    "variant" TEXT,
    "publisher" TEXT,
    "releaseDate" TIMESTAMP(3),
    "format" TEXT,
    "addedDate" TIMESTAMP(3),
    "coverDate" TEXT,
    "barcode" TEXT,
    "storyArc" TEXT,
    "grade" TEXT,
    "rawOrSlabbed" TEXT,
    "keyLevel" TEXT,
    "keyCategory" TEXT,
    "keyReason" TEXT,
    "purchasePrice" DECIMAL(12,2),
    "priceSold" DECIMAL(12,2),
    "covrPriceValue" DECIMAL(12,2),
    "coverPrice" DECIMAL(12,2),
    "notes" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "storageBox" TEXT,
    "age" TEXT,
    "country" TEXT,
    "crossover" TEXT,
    "fullTitle" TEXT,
    "genre" TEXT,
    "imprint" TEXT,
    "language" TEXT,
    "releaseYear" INTEGER,
    "seriesGroup" TEXT,
    "subtitle" TEXT,
    "title" TEXT,
    "coverYear" INTEGER,
    "pageCount" INTEGER,
    "addedYear" INTEGER,
    "bagBoardDate" TIMESTAMP(3),
    "bagBoardYear" INTEGER,
    "collectionStatus" TEXT,
    "modifiedDate" TIMESTAMP(3),
    "myRating" DECIMAL(4,2),
    "owner" TEXT,
    "plot" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readDate" TIMESTAMP(3),
    "readYear" INTEGER,
    "tags" TEXT,
    "customLabel" TEXT,
    "graderNotes" TEXT,
    "gradingCompany" TEXT,
    "labelType" TEXT,
    "myValue" DECIMAL(12,2),
    "pageQuality" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchaseStore" TEXT,
    "purchaseYear" INTEGER,
    "signedBy" TEXT,
    "slabCertNumber" TEXT,
    "soldDate" TIMESTAMP(3),
    "soldYear" INTEGER,
    "value" DECIMAL(12,2),
    "coverUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'clz',
    "rawRow" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "id" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "publisher" TEXT NOT NULL DEFAULT '',
    "issueNo" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "comicId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Comic_dedupeKey_key" ON "Comic"("dedupeKey");

-- CreateIndex
CREATE INDEX "Comic_seriesSort_idx" ON "Comic"("seriesSort");

-- CreateIndex
CREATE INDEX "Comic_coreSeriesId_idx" ON "Comic"("coreSeriesId");

-- CreateIndex
CREATE INDEX "Comic_publisher_idx" ON "Comic"("publisher");

-- CreateIndex
CREATE INDEX "Comic_barcode_idx" ON "Comic"("barcode");

-- CreateIndex
CREATE INDEX "Comic_storageBox_idx" ON "Comic"("storageBox");

-- CreateIndex
CREATE INDEX "Comic_keyLevel_idx" ON "Comic"("keyLevel");

-- CreateIndex
CREATE INDEX "Comic_rawOrSlabbed_idx" ON "Comic"("rawOrSlabbed");

-- CreateIndex
CREATE INDEX "Comic_read_idx" ON "Comic"("read");

-- CreateIndex
CREATE INDEX "WishlistItem_series_idx" ON "WishlistItem"("series");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_series_publisher_issueNo_key" ON "WishlistItem"("series", "publisher", "issueNo");

-- CreateIndex
CREATE INDEX "PriceSnapshot_comicId_fetchedAt_idx" ON "PriceSnapshot"("comicId", "fetchedAt");

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_comicId_fkey" FOREIGN KEY ("comicId") REFERENCES "Comic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

