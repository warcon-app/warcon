import { expect, test } from 'bun:test';
import { parseRange } from './analytics';

test('analytics accepts the two and three day ranges while retaining the fallback', () => {
 expect(parseRange('48h')).toBe('48h');
 expect(parseRange('3d')).toBe('3d');
 expect(parseRange('7d')).toBe('7d');
 expect(parseRange('unknown')).toBe('24h');
});
