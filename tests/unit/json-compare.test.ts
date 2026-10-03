import { describe, expect, it } from 'vitest';
import {
  JSON_COMPARE_LIMITS,
  compareJsonText,
  expandJsonNumber,
  parseJsonForCompare,
} from '../../shared/json-compare';

/**
 * Whether two JSON documents say the same thing.
 *
 * Every case the brief named is here: key ordering, numeric representation, arrays, null, duplicate
 * keys, invalid JSON. The two that matter most are the ones that would produce a **false match** —
 * duplicate keys and large numbers — because a false difference is noise and a false match is silent
 * data loss.
 */
describe('JSON documents that say the same thing', () => {
  it('ignores object key order, at every depth', () => {
    expect(compareJsonText('{"a":1,"b":2}', '{"b":2,"a":1}').verdict).toBe('EQUAL');
    expect(
      compareJsonText(
        '{"outer":{"x":1,"y":[{"p":1,"q":2}]},"z":3}',
        '{"z":3,"outer":{"y":[{"q":2,"p":1}],"x":1}}',
      ).verdict,
    ).toBe('EQUAL');
  });

  it('ignores insignificant whitespace', () => {
    expect(compareJsonText('{ "a" : [ 1 , 2 ] }', '{"a":[1,2]}').verdict).toBe('EQUAL');
  });

  it('treats the same number written differently as the same number', () => {
    for (const [a, b] of [
      ['{"n":1}', '{"n":1.0}'],
      ['{"n":1}', '{"n":1e0}'],
      ['{"n":1000}', '{"n":1e3}'],
      ['{"n":0.001}', '{"n":1e-3}'],
      ['{"n":-2.50}', '{"n":-2.5}'],
      ['{"n":1.5e2}', '{"n":150}'],
    ]) {
      expect(compareJsonText(a!, b!).verdict, `${a} vs ${b}`).toBe('EQUAL');
    }
  });

  it('keeps big integers exact, where JSON.parse would call two different numbers equal', () => {
    // The reason this file has its own parser. Both of these become 1.2345678901234567e19 as doubles.
    const a = '{"id":12345678901234567890}';
    const b = '{"id":12345678901234567891}';
    expect(JSON.parse(a).id === JSON.parse(b).id, 'JSON.parse cannot tell these apart').toBe(true);
    expect(compareJsonText(a, b).verdict, 'this comparison can').toBe('DIFFERENT');

    // And the same enormous integer written twice is still equal.
    expect(compareJsonText(a, '{"id":12345678901234567890}').verdict).toBe('EQUAL');
  });

  it('keeps wide decimals exact too', () => {
    expect(compareJsonText('{"v":0.1000000000000000001}', '{"v":0.1}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"v":123456789012345678.90}', '{"v":123456789012345678.9}').verdict).toBe(
      'EQUAL',
    );
  });

  it('treats array order as significant, because a JSON array is a sequence', () => {
    expect(compareJsonText('{"a":[1,2]}', '{"a":[2,1]}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('[1,2,3]', '[1,2,3]').verdict).toBe('EQUAL');
    expect(compareJsonText('[1,2]', '[1,2,3]').verdict).toBe('DIFFERENT');
    expect(compareJsonText('[]', '{}').verdict).toBe('DIFFERENT');
  });

  it('distinguishes a key holding null from a key that is absent', () => {
    expect(compareJsonText('{"a":null}', '{}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"a":null}', '{"a":null}').verdict).toBe('EQUAL');
    // And null is not any of the things that are sometimes written for it.
    expect(compareJsonText('{"a":null}', '{"a":""}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"a":null}', '{"a":0}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"a":null}', '{"a":false}').verdict).toBe('DIFFERENT');
  });

  it('compares strings exactly, after unescaping, and does not borrow a column’s tolerances', () => {
    expect(compareJsonText('{"s":"\\u0041"}', '{"s":"A"}').verdict).toBe('EQUAL');
    expect(compareJsonText('{"s":"a\\/b"}', '{"s":"a/b"}').verdict).toBe('EQUAL');
    // Trailing whitespace is trimmed when comparing a *column*. Inside a document it is content.
    expect(compareJsonText('{"s":"a "}', '{"s":"a"}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"s":"A"}', '{"s":"a"}').verdict).toBe('DIFFERENT');
    // A number and the string of that number are different things.
    expect(compareJsonText('{"s":"1"}', '{"s":1}').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"s":"true"}', '{"s":true}').verdict).toBe('DIFFERENT');
  });
});

describe('JSON that cannot honestly be compared', () => {
  it('refuses to pick a winner when a document repeats a key', () => {
    /**
     * `JSON.parse('{"a":1,"a":2}')` is `{a:2}`, so comparing parsed objects would call these two
     * documents equal — they are not, and which value counts is the parser's choice rather than the
     * data's. The only honest answer is that it was not compared.
     */
    const result = compareJsonText('{"a":1,"a":2}', '{"a":2}');
    expect(result.verdict).toBe('NOT_COMPARABLE');
    expect(result.reason).toMatch(/repeats the key "a"/);

    // Even when the duplicate is on the other side, or nested, or the texts look unrelated.
    expect(compareJsonText('{"a":1}', '{"a":1,"a":1}').verdict).toBe('NOT_COMPARABLE');
    expect(compareJsonText('{"o":{"k":1,"k":2}}', '{"o":{"k":2}}').verdict).toBe('NOT_COMPARABLE');
  });

  it('declines a document past the limits rather than guessing', () => {
    const tiny = { maxBytes: 40, maxDepth: 4, maxNodes: 6 };

    const big = compareJsonText(`{"a":"${'x'.repeat(100)}"}`, '{"a":"y"}', tiny);
    expect(big.verdict).toBe('NOT_COMPARABLE');
    expect(big.reason).toMatch(/comparison limit/);

    const deep = compareJsonText('{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}', '{"a":1}', tiny);
    expect(deep.verdict).toBe('NOT_COMPARABLE');
    expect(deep.reason).toMatch(/nests deeper/);

    const many = compareJsonText('[1,2,3,4,5,6,7,8,9]', '[1]', tiny);
    expect(many.verdict).toBe('NOT_COMPARABLE');
    expect(many.reason).toMatch(/more than 6 values/);
  });

  it('still calls a byte-identical document equal, even past the limits', () => {
    // Worth having: a 2 MB document that was not touched by the migration should read as equal
    // rather than as "could not be compared", which would be true but useless.
    const huge = `{"a":"${'x'.repeat(200)}"}`;
    expect(compareJsonText(huge, huge, { maxBytes: 40, maxDepth: 4, maxNodes: 6 }).verdict).toBe('EQUAL');
  });
});

describe('text that is not JSON', () => {
  it('reports a real difference rather than hiding behind "not comparable"', () => {
    // A limit is our constraint. Invalid text is a fact about the data, and the answer is known.
    expect(compareJsonText('{"a":1}', 'not json at all').verdict).toBe('DIFFERENT');
    expect(compareJsonText('not json', 'also not json').verdict).toBe('DIFFERENT');
    expect(compareJsonText('{"a":1,}', '{"a":1}').verdict).toBe('DIFFERENT');
  });

  it('rejects the things a lenient parser would accept, so it matches what a database would store', () => {
    for (const bad of [
      "{'a':1}", // single quotes
      '{a:1}', // unquoted key
      '{"a":01}', // leading zero
      '{"a":.5}', // no integer part
      '{"a":1.}', // no fraction digits
      '{"a":+1}', // leading plus
      '{"a":undefined}',
      '{"a":NaN}',
      '{"a":1}trailing',
      '[1,2',
      '{"a":"unterminated}',
    ]) {
      expect(parseJsonForCompare(bad).ok, bad).toBe(false);
    }
  });

  it('accepts a bare value, because a jsonb column can hold one', () => {
    for (const good of ['1', '"text"', 'true', 'false', 'null', '[]', '{}', '-0.5e-3']) {
      expect(parseJsonForCompare(good).ok, good).toBe(true);
    }
    expect(compareJsonText('1', '1.0').verdict).toBe('EQUAL');
    expect(compareJsonText('null', 'null').verdict).toBe('EQUAL');
  });
});

describe('expanding a JSON number literal', () => {
  it('turns exponents into plain digits so two literals can be compared exactly', () => {
    expect(expandJsonNumber('1e3')).toBe('1000');
    expect(expandJsonNumber('1.5e2')).toBe('150');
    expect(expandJsonNumber('1e-3')).toBe('0.001');
    expect(expandJsonNumber('-2.5e-1')).toBe('-0.25');
    expect(expandJsonNumber('1.23e1')).toBe('12.3');
    expect(expandJsonNumber('5')).toBe('5');
    expect(expandJsonNumber('-0.5')).toBe('-0.5');
    // Large exponents stay exact rather than going through a double.
    expect(expandJsonNumber('1e20')).toBe('100000000000000000000');
  });
});

describe('the limits are the shipped ones', () => {
  it('states them, so a change to them is a visible change', () => {
    expect(JSON_COMPARE_LIMITS).toEqual({ maxBytes: 1_000_000, maxDepth: 64, maxNodes: 50_000 });
  });
});
