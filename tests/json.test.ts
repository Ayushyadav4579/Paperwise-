import { describe, expect, it } from 'vitest';
import { extractJsonObject, isRecord, readConfidence, readNumber, readText, readTextList } from '../src/ai/json';
import { AiError } from '../src/ai/errors';

describe('model output parsing', () => {
  it('reads plain JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON wrapped in code fences and prose', () => {
    const raw = 'Here is the result:\n```json\n{"score": 2, "rationale": "Good."}\n```\nHope that helps.';
    expect(extractJsonObject(raw)).toEqual({ score: 2, rationale: 'Good.' });
  });

  it('ignores braces inside strings', () => {
    const raw = '{"feedback":"The set {1,2} is correct","awarded":1}';
    expect(extractJsonObject(raw)).toEqual({ feedback: 'The set {1,2} is correct', awarded: 1 });
  });

  it('finds a valid object after an invalid brace', () => {
    expect(extractJsonObject('not a json {oops} then {"ok":true}')).toEqual({ ok: true });
  });

  it('rejects an empty reply with a typed error', () => {
    expect(() => extractJsonObject('')).toThrow(AiError);
    expect(() => extractJsonObject('   ')).toThrow(/empty/i);
  });

  it('rejects a reply with no JSON object', () => {
    expect(() => extractJsonObject('The answer is probably 3 marks.')).toThrow(/valid JSON/i);
  });

  it('does not accept a top-level array as the grading object', () => {
    expect(() => extractJsonObject('[{"ref":"Q1","awarded":1}]')).toThrow(/list instead of a JSON object/i);
  });
});

describe('value coercion', () => {
  it('accepts numeric strings but not fractions or words', () => {
    expect(readNumber(2)).toBe(2);
    expect(readNumber('2.5')).toBe(2.5);
    expect(readNumber('2/3')).toBeNull();
    expect(readNumber('two')).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readNumber(Number.NaN)).toBeNull();
  });

  it('bounds and cleans text', () => {
    expect(readText('  a   b  ', 10)).toBe('a b');
    expect(readText(null)).toBe('');
    expect(readText('x'.repeat(20), 5)).toHaveLength(5);
  });

  it('deduplicates and limits lists', () => {
    expect(readTextList(['a point', 'a point', '', 'another point', 5], 3)).toEqual(['a point', 'another point']);
    expect(readTextList('not a list')).toEqual([]);
  });

  it('accepts only known confidence values', () => {
    expect(readConfidence('HIGH')).toBe('high');
    expect(readConfidence('certain')).toBeNull();
    expect(readConfidence(1)).toBeNull();
  });

  it('identifies records only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
