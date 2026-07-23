import { describe, expect, it } from 'vitest';
import { hashContent } from './contentHash.js';

describe('hashContent', () => {
  it('is deterministic for identical input', () => {
    const a = hashContent('EN Title', 'EN body', 'عنوان', 'متن');
    const b = hashContent('EN Title', 'EN body', 'عنوان', 'متن');
    expect(a).toBe(b);
  });

  it('is insensitive to case and extra whitespace', () => {
    const a = hashContent('EN Title', 'EN body', 'عنوان', 'متن');
    const b = hashContent('en   title', '  EN BODY', 'عنوان', '  متن  ');
    expect(a).toBe(b);
  });

  it('differs when only the Persian half changes (both halves matter)', () => {
    const a = hashContent('EN Title', 'EN body', 'عنوان یک', 'متن یک');
    const b = hashContent('EN Title', 'EN body', 'عنوان دو', 'متن دو');
    expect(a).not.toBe(b);
  });

  it('differs when only the English half changes', () => {
    const a = hashContent('Title A', 'Body A', 'عنوان', 'متن');
    const b = hashContent('Title B', 'Body B', 'عنوان', 'متن');
    expect(a).not.toBe(b);
  });
});
