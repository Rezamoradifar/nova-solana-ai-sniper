-- AlterTable
-- Additive column with a default — every existing row becomes "en", the
-- language the bot already speaks today. No existing data is modified or removed.
ALTER TABLE "users" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
