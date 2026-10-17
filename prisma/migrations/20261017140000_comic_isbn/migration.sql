-- AlterTable
ALTER TABLE "Comic" ADD COLUMN "isbn" TEXT;

-- CreateIndex
CREATE INDEX "Comic_isbn_idx" ON "Comic"("isbn");

-- 13-digit ISBN (978 or 979). Spaces and hyphens are ignored. A longer UPC is left alone.
UPDATE "Comic"
SET "isbn" = regexp_replace("barcode", '[^0-9]', '', 'g')
WHERE "barcode" IS NOT NULL
  AND regexp_replace("barcode", '[^0-9]', '', 'g') ~ '^(978|979)[0-9]{10}$';

-- 10-digit ISBN, stored as ISBN-13. The barcode itself is only those 10 characters.
UPDATE "Comic" AS c
SET "isbn" = s.base || (
  (
    10 - (
      (
        CAST(substr(s.base, 1, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 2, 1) AS INTEGER) * 3 +
        CAST(substr(s.base, 3, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 4, 1) AS INTEGER) * 3 +
        CAST(substr(s.base, 5, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 6, 1) AS INTEGER) * 3 +
        CAST(substr(s.base, 7, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 8, 1) AS INTEGER) * 3 +
        CAST(substr(s.base, 9, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 10, 1) AS INTEGER) * 3 +
        CAST(substr(s.base, 11, 1) AS INTEGER) * 1 +
        CAST(substr(s.base, 12, 1) AS INTEGER) * 3
      ) % 10
    )
  ) % 10
)::text
FROM (
  SELECT id, '978' || left(code, 9) AS base
  FROM (
    SELECT id, upper(regexp_replace("barcode", '[^0-9Xx]', '', 'g')) AS code
    FROM "Comic"
    WHERE "isbn" IS NULL
      AND "barcode" IS NOT NULL
  ) raw
  WHERE length(code) = 10
    AND code ~ '^[0-9]{9}[0-9X]$'
) AS s
WHERE c.id = s.id;
