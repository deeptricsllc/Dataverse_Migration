import { describe, expect, it } from 'vitest';
import { newerThanWatermark, WATERMARK_VALUE } from '../../server/src/connectors/types';
import { observeWatermark } from '../../server/src/services/migration-engine';
import type { DvRecord } from '../../shared/metadata';

/**
 * Reading only what changed.
 *
 * The rules here decide whether a recurring migration keeps up or silently loses records, so each
 * one is pinned: what counts as newer, how far a run says it got, and what a watermark is allowed
 * to be before it reaches a query.
 */

describe('watermark comparison', () => {
  it('compares timestamps as instants, not as text', () => {
    expect(newerThanWatermark('2026-09-26T10:00:01Z', '2026-09-26T10:00:00Z')).toBe(true);
    expect(newerThanWatermark('2026-09-26T10:00:00Z', '2026-09-26T10:00:00Z')).toBe(false);
    expect(newerThanWatermark('2026-09-26T09:59:59Z', '2026-09-26T10:00:00Z')).toBe(false);
    // Different offsets for the same instant are not "newer".
    expect(newerThanWatermark('2026-09-26T11:00:00+01:00', '2026-09-26T10:00:00Z')).toBe(false);
    // A later instant written in another offset still is.
    expect(newerThanWatermark('2026-09-26T12:00:00+01:00', '2026-09-26T10:00:00Z')).toBe(true);
  });

  it('compares numeric versions numerically', () => {
    // Text comparison would put 9 after 10, which for a row version loses every record in between.
    expect(newerThanWatermark('10', '9')).toBe(true);
    expect(newerThanWatermark('9', '10')).toBe(false);
    expect(newerThanWatermark('100000', '99999')).toBe(true);
  });

  it('treats a missing value as not newer, and an unreadable one as newer', () => {
    // Null cannot be shown to have changed, so it is left alone.
    expect(newerThanWatermark(null, '2026-09-26T10:00:00Z')).toBe(false);
    expect(newerThanWatermark(undefined, '1')).toBe(false);
    // Something unparseable is included instead: re-migrating a record is recoverable, skipping a
    // changed one is not.
    expect(newerThanWatermark('not a date', '2026-09-26T10:00:00Z')).toBe(true);
  });
});

describe('what a run reports it read up to', () => {
  const record = (id: string, modifiedon: string | null): DvRecord => ({
    id,
    values: { modifiedon, name: `record ${id}` },
  });

  it('takes the maximum, not the last record read', () => {
    // Records arrive in primary-key order, so the newest one is not the last one.
    const watermark = { value: null as string | null };
    observeWatermark(
      watermark,
      [
        record('a', '2026-09-20T08:00:00Z'),
        record('b', '2026-09-26T17:30:00Z'),
        record('c', '2026-09-22T09:00:00Z'),
      ],
      'modifiedon',
    );
    expect(watermark.value).toBe('2026-09-26T17:30:00Z');
  });

  it('carries on from where a previous page left off, and never goes backwards', () => {
    const watermark = { value: '2026-09-26T17:30:00Z' };
    observeWatermark(watermark, [record('d', '2026-09-01T00:00:00Z')], 'modifiedon');
    expect(watermark.value).toBe('2026-09-26T17:30:00Z');
    observeWatermark(watermark, [record('e', '2026-09-27T00:00:00Z')], 'modifiedon');
    expect(watermark.value).toBe('2026-09-27T00:00:00Z');
  });

  it('ignores records with no value in the watermark column', () => {
    const watermark = { value: null as string | null };
    observeWatermark(watermark, [record('a', null), record('b', null)], 'modifiedon');
    expect(watermark.value).toBeNull();
  });

  it('ignores a value that is not a timestamp or a number', () => {
    // A lookup or a choice array has no ordering a watermark could use; treating one as a watermark
    // would invent one.
    const watermark = { value: null as string | null };
    observeWatermark(
      watermark,
      [
        { id: 'a', values: { modifiedon: { id: 'x', logicalName: 'systemuser' } } },
        { id: 'b', values: { modifiedon: [1, 2, 3] } },
        { id: 'c', values: { modifiedon: true } },
      ],
      'modifiedon',
    );
    expect(watermark.value).toBeNull();
  });
});

describe('what a watermark value may be', () => {
  it('accepts the shapes a real watermark takes', () => {
    for (const value of [
      '2026-09-26',
      '2026-09-26T10:00:00Z',
      '2026-09-26T10:00:00.1234567Z',
      '2026-09-26T10:00:00+01:00',
      '2026-09-26 10:00',
      '0',
      '1234567890',
      '12.5',
    ]) {
      expect(WATERMARK_VALUE.test(value), value).toBe(true);
    }
  });

  it('rejects anything that could turn a filter into something else', () => {
    // A watermark arrives from a stored schedule and ends up inside an OData filter, so it is input.
    for (const value of [
      "2026-09-26' or 1 eq 1",
      'modifiedon gt 2020-01-01',
      '2026-09-26T10:00:00Z and contains(name,%27x%27)',
      '*',
      '',
      ' ',
      '2026-09-26;drop',
    ]) {
      expect(WATERMARK_VALUE.test(value), value).toBe(false);
    }
  });
});
