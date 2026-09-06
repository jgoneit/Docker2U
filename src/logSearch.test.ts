import { describe, expect, it } from 'vitest';
import { findLogMatches } from './logSearch';

describe('literal log matching', () => {
  it('finds case-insensitive text and treats regular expression syntax literally', () => {
    expect(findLogMatches('ERROR error Error', 'eRrOr')).toEqual([0, 6, 12]);
    expect(findLogMatches('first .* [x] then .*', '.*')).toEqual([6, 18]);
    expect(findLogMatches('first .* [x] then .*', '[x]')).toEqual([9]);
    expect(findLogMatches('x\\path', '\\')).toEqual([1]);
    expect(findLogMatches('not empty', '')).toEqual([]);
  });
  it('retains original offsets after Unicode text', () => {
    expect(findLogMatches('İ first ERROR 한글 error', 'error')).toEqual([8, 17]);
  });
});
