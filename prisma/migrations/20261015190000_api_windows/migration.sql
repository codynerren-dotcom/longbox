-- CreateTable
CREATE TABLE "ApiWindow" (
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiWindow_pkey" PRIMARY KEY ("key")
);
