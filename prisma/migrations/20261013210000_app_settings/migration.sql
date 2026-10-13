CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "secret" TEXT,
    "plain" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
