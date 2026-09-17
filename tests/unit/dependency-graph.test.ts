import { describe, expect, it } from 'vitest';
import { analyzeDependencies, stronglyConnectedComponents } from '../../server/src/services/dependency-graph';
import { attr, lookup, table } from './fixtures';

const targets = (...names: string[]) => new Set(names);

describe('dependency engine', () => {
  it('orders an acyclic graph topologically', () => {
    const region = table('region', [attr('name', 'String')]);
    const office = table('office', [lookup('regionid', ['region'], true)]);
    const employee = table('employee', [lookup('officeid', ['office'], true)]);
    const a = analyzeDependencies({
      tables: [employee, office, region],
      targetTables: targets('region', 'office', 'employee'),
    });
    expect(a.order).toEqual(['region', 'office', 'employee']);
    expect(a.cycles).toEqual([]);
    expect(a.nodes.find((n) => n.logicalName === 'region')!.dependents).toHaveLength(1);
  });

  it('finds strongly connected components', () => {
    const adj = new Map([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['a']],
    ]);
    const comps = stronglyConnectedComponents(['a', 'b', 'c'], adj);
    expect(comps).toContainEqual(['a', 'b']);
    expect(comps).toContainEqual(['c']);
  });

  it('breaks a cycle by deferring an optional lookup (two-pass strategy)', () => {
    const region = table('region', [lookup('headofficeid', ['office'])]);
    const office = table('office', [lookup('regionid', ['region'], true)]);
    const a = analyzeDependencies({ tables: [region, office], targetTables: targets('region', 'office') });
    expect(a.cycles).toHaveLength(1);
    expect(a.cycles[0].resolvable).toBe(true);
    expect(a.cycles[0].deferredEdges.map((e) => `${e.from}.${e.attribute}`)).toEqual(['region.headofficeid']);
    expect(a.order).toEqual(['region', 'office']);
  });

  it('handles self references', () => {
    const account = table('account', [lookup('parentaccountid', ['account'])]);
    const a = analyzeDependencies({ tables: [account], targetTables: targets('account') });
    expect(a.cycles[0].deferredEdges[0].attribute).toBe('parentaccountid');
    expect(a.order).toEqual(['account']);
  });

  it('defers only the cyclic target of a polymorphic lookup', () => {
    const account = table('account', [lookup('primarycontactid', ['contact'])]);
    const contact = table('contact', [lookup('parentcustomerid', ['account', 'contact'])]);
    const a = analyzeDependencies({
      tables: [account, contact],
      targetTables: targets('account', 'contact'),
    });
    const deferred = a.cycles.flatMap((c) => c.deferredEdges.map((e) => `${e.from}.${e.attribute}->${e.to}`));
    expect(deferred).toContain('contact.parentcustomerid->contact');
    expect(deferred).not.toContain('contact.parentcustomerid->account');
    expect(a.order).toEqual(['account', 'contact']);
  });

  it('reports cycles of required lookups as unresolvable without crashing', () => {
    const a1 = table('a', [lookup('bid', ['b'], true)]);
    const b1 = table('b', [lookup('aid', ['a'], true)]);
    const a = analyzeDependencies({ tables: [a1, b1], targetTables: targets('a', 'b') });
    expect(a.cycles[0].resolvable).toBe(false);
    expect(a.order.sort()).toEqual(['a', 'b']);
    expect(a.nodes.every((n) => n.order === null)).toBe(true);
    expect(a.nodes[0].warnings.join()).toMatch(/cannot be resolved automatically/);
  });

  it('classifies dependencies outside the selection', () => {
    const contact = table('contact', [
      lookup('accountid', ['account']),
      lookup('currencyid', ['transactioncurrency']),
      lookup('legacyid', ['legacy']),
      attr('ownerid', 'Owner', { targets: ['systemuser'] }),
    ]);
    const a = analyzeDependencies({
      tables: [contact],
      targetTables: targets('contact', 'account', 'transactioncurrency'),
    });
    const kinds = Object.fromEntries(a.nodes[0].dependsOn.map((e) => [e.attribute, e.kind]));
    expect(kinds).toEqual({
      accountid: 'NOT_SELECTED',
      currencyid: 'PLATFORM',
      legacyid: 'MISSING_IN_TARGET',
    });
    expect(a.missingDependencies).toEqual([
      { table: 'account', requiredBy: [{ table: 'contact', attribute: 'accountid', required: false }] },
    ]);
  });

  it('ignores lookups that are not mapped', () => {
    const office = table('office', [lookup('regionid', ['region'], true)]);
    const region = table('region', [lookup('headofficeid', ['office'])]);
    const a = analyzeDependencies({
      tables: [office, region],
      targetTables: targets('office', 'region'),
      mappedLookups: new Map([
        ['office', new Set(['regionid'])],
        ['region', new Set<string>()],
      ]),
    });
    expect(a.cycles).toEqual([]);
    expect(a.order).toEqual(['region', 'office']);
  });
});
