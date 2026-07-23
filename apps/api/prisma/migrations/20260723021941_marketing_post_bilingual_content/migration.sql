/*
  Warnings:

  - You are about to drop the column `body` on the `marketing_posts` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `marketing_posts` table. All the data in the column will be lost.
  - Added the required column `bodyEn` to the `marketing_posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bodyFa` to the `marketing_posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `titleEn` to the `marketing_posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `titleFa` to the `marketing_posts` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "marketing_posts" DROP COLUMN "body",
DROP COLUMN "title",
ADD COLUMN     "bodyEn" TEXT NOT NULL,
ADD COLUMN     "bodyFa" TEXT NOT NULL,
ADD COLUMN     "titleEn" TEXT NOT NULL,
ADD COLUMN     "titleFa" TEXT NOT NULL;
