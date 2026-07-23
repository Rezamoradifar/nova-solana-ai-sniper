import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { escapeMarkup, renderTextLayer } from './textLayer.js';
import { FONTS, THEME } from './theme.js';

describe('escapeMarkup', () => {
  it('escapes every Pango/XML-significant character', () => {
    expect(escapeMarkup(`<b>&"'</b>`)).toBe('&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;');
  });

  it('leaves ordinary text (including non-Latin scripts) untouched', () => {
    expect(escapeMarkup('79 tokens screened — فارسی متن')).toBe('79 tokens screened — فارسی متن');
  });
});

describe('renderTextLayer', () => {
  it('produces a valid, non-empty PNG buffer sized to the requested box', async () => {
    const buffer = await renderTextLayer({
      text: '79',
      color: THEME.ink,
      fontFile: FONTS.monoBold,
      width: 400,
      height: 200,
    });

    expect(buffer.length).toBeGreaterThan(0);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeLessThanOrEqual(400);
    expect(metadata.height).toBeLessThanOrEqual(200);
  });

  it('does not throw on text containing markup-special characters (regression: unescaped AI copy could break rendering)', async () => {
    await expect(
      renderTextLayer({
        text: `<script>alert("x")</script> & friends`,
        color: THEME.ink,
        fontFile: FONTS.displayBold,
        width: 800,
        height: 100,
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
