import { describe, expect, it } from 'vitest';
import { tradingViewDocument } from './tradingViewEmbed.js';

describe('isolated market chart document', () => {
  it('does not turn a symbol into executable markup', () => {
    const symbol = '</script><script>window.parent.compromised=true</script>';
    const document = tradingViewDocument(symbol);
    expect(document.match(/<script/g)).toHaveLength(1);
    const body = document.match(/async>(.*?)<\/script>/s)?.[1];
    expect(JSON.parse(body!).symbol).toBe(symbol);
    expect(document).not.toContain('<script>window.parent');
  });
});
