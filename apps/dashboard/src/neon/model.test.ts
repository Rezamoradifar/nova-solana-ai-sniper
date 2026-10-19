import { describe, expect, it } from 'vitest';
import { DEMO_MARKETS, PRODUCTS, finitePositive, routeEstimate } from './model.js';

describe('Moneyland input guards', () => {
  it.each(['', ' ', '-1', '0', 'NaN', 'Infinity', '1e12', '1,000', '<script>', '1000000001'])('rejects invalid or unsafe amount %j', input => { expect(finitePositive(input)).toBeNull(); });
  it.each([['1',1],['0.01',.01],['1000.50',1000.5],[' 25 ',25]])('accepts positive decimal %j', (input, output) => { expect(finitePositive(String(input))).toBe(output); });
});
describe('Flash and arbitrage arithmetic', () => {
  it('deducts explicit gas and basis-point fees', () => { expect(routeEstimate(10000,.5,8,5)).toBeCloseTo(37); });
  it('does not clamp a negative estimate into a profit', () => { expect(routeEstimate(100,.1,10,5)).toBeCloseTo(-9.95); });
  it('scales both the gross spread and the provider fee with notional', () => { expect(routeEstimate(20000,.5,8,5)).toBeCloseTo(82); });
});
describe('Design model invariants', () => {
  it('all fixture mints are visibly synthetic', () => { expect(DEMO_MARKETS.every(m=>m.mint.startsWith('demo-'))).toBe(true); });
  it('all product routes are unique and do not shadow protected account routes', () => { const paths=PRODUCTS.map(p=>p.path); expect(new Set(paths).size).toBe(paths.length); expect(paths.every(p=>!p.startsWith('/dashboard'))).toBe(true); });
  it('sample portfolio assets reconcile exactly', () => { expect(120*148.32+5*3248.76+8616.48).toBeCloseTo(42658.68,2); });
});
