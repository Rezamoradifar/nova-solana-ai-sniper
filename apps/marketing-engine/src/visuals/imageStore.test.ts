import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { GENERATED_IMAGES_DIR, saveGeneratedImage } from './imageStore.js';

const writtenPaths: string[] = [];

afterEach(async () => {
  await Promise.all(writtenPaths.splice(0).map((p) => fs.unlink(p).catch(() => undefined)));
});

describe('saveGeneratedImage', () => {
  it('writes the exact bytes given, readable back from the returned path', async () => {
    const buffer = Buffer.from('fake-png-bytes');
    const filePath = await saveGeneratedImage(buffer, 'market_updates');
    writtenPaths.push(filePath);

    expect(filePath).toContain(GENERATED_IMAGES_DIR);
    expect(filePath).toContain('market_updates');
    const readBack = await fs.readFile(filePath);
    expect(readBack).toEqual(buffer);
  });

  it('gives two saves of the same category distinct filenames (never overwrites a concurrent save)', async () => {
    const [pathA, pathB] = await Promise.all([
      saveGeneratedImage(Buffer.from('a'), 'news'),
      saveGeneratedImage(Buffer.from('b'), 'news'),
    ]);
    writtenPaths.push(pathA, pathB);
    expect(pathA).not.toBe(pathB);
  });
});
