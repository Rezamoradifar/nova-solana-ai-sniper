import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Local, un-served filesystem storage — see MarketingPost.imagePath's own
 * schema doc comment for why this is never a public URL. Resolved relative
 * to this file (not process.cwd()) so it's correct regardless of where the
 * process was started from (pm2's cwd is the repo root, not this package). */
export const GENERATED_IMAGES_DIR = path.join(__dirname, '..', '..', 'generated-images');

/** Persists a rendered visual to disk and returns its path. Filenames are
 * non-guessable (random suffix) purely to avoid accidental collisions
 * between concurrent runs — these files carry no sensitive data, unlike
 * anything under security/keystore.ts's world. */
export async function saveGeneratedImage(buffer: Buffer, category: string): Promise<string> {
  await fs.mkdir(GENERATED_IMAGES_DIR, { recursive: true });
  const filename = `${category}-${Date.now()}-${randomBytes(4).toString('hex')}.png`;
  const filePath = path.join(GENERATED_IMAGES_DIR, filename);
  await fs.writeFile(filePath, buffer);
  return filePath;
}
