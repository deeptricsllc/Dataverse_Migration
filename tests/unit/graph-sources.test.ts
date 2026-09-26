import { describe, expect, it } from 'vitest';
import {
  fetchDriveItem,
  fetchListRows,
  GRAPH_READ_SCOPES,
  resolveGraphTarget,
  resolveListReference,
  sharingLinkToShareId,
  type GraphRequest,
} from '../../server/src/connectors/staged/graph';
import { inferTable } from '../../server/src/connectors/staged/infer-schema';

/**
 * Reading from OneDrive and SharePoint.
 *
 * The live Graph call is one thin function; everything with a decision in it — which endpoint a
 * pasted link means, how a sharing link is encoded, how list items become rows — is here, tested
 * against a stubbed Graph. That is deliberate: a wrong sharing-link encoding does not fail loudly, it
 * returns "not found" for a link that is perfectly valid and sends somebody hunting for a
 * permissions problem that does not exist.
 */

/** A Graph that answers from a script, recording what was asked of it. */
function stubGraph(routes: Record<string, { status?: number; json?: unknown; body?: Buffer }>) {
  const asked: string[] = [];
  const request: GraphRequest = async (path) => {
    asked.push(path);
    // Longest prefix wins. `sites/s1/lists/l1` is a prefix of `sites/s1/lists/l1/items?...`, so
    // matching the shortest would answer an items request with the list's metadata.
    const key =
      path in routes
        ? path
        : Object.keys(routes)
            .filter((k) => path.startsWith(k))
            .sort((a, b) => b.length - a.length)[0];
    const match = key === undefined ? undefined : routes[key];
    return match ? { status: match.status ?? 200, json: match.json, body: match.body } : { status: 404 };
  };
  return { request, asked };
}

describe('which Graph endpoint a reference means', () => {
  it('encodes a sharing link the way /shares requires', () => {
    // base64url of the URL, `u!` prefixed, padding removed. Getting any part of this wrong returns
    // "item not found" for a valid link.
    const id = sharingLinkToShareId('https://contoso-my.sharepoint.com/:x:/g/personal/a_b/Xyz?e=1');
    expect(id.startsWith('u!')).toBe(true);
    expect(id).not.toContain('=');
    expect(id).not.toContain('+');
    expect(id).not.toContain('/');
    // It really is the URL, recoverable from the encoding.
    const decoded = Buffer.from(id.slice(2).replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString();
    expect(decoded).toBe('https://contoso-my.sharepoint.com/:x:/g/personal/a_b/Xyz?e=1');
  });

  it('routes a sharing link through /shares', () => {
    const target = resolveGraphTarget('https://contoso.sharepoint.com/:x:/g/Documents/extract.xlsx');
    expect(target.itemPath).toMatch(/^shares\/u!/);
    expect(target.contentPath).toMatch(/^shares\/u!.*\/driveItem\/content$/);
    // The provenance recorded is the link somebody actually pasted.
    expect(target.sourceRef).toBe('https://contoso.sharepoint.com/:x:/g/Documents/extract.xlsx');
  });

  it('uses a Graph path as given, rather than second-guessing it', () => {
    const target = resolveGraphTarget('drives/b!abc/items/01XYZ');
    expect(target.itemPath).toBe('drives/b!abc/items/01XYZ');
    expect(target.contentPath).toBe('drives/b!abc/items/01XYZ/content');
    // A path that already ends in /content is not given a second one.
    expect(resolveGraphTarget('drives/b!abc/items/01XYZ/content').contentPath).toBe(
      'drives/b!abc/items/01XYZ/content',
    );
    expect(resolveGraphTarget('/sites/s1/drive/root:/Reports/q1.csv').itemPath).toBe(
      'sites/s1/drive/root:/Reports/q1.csv',
    );
  });

  it("addresses a path in the user's own drive, encoding each segment", () => {
    // A space or a `#` in a folder name would otherwise change which item is addressed.
    const target = resolveGraphTarget('Shared Documents/Q1 #final/extract.csv');
    expect(target.itemPath).toBe('me/drive/root:/Shared%20Documents/Q1%20%23final/extract.csv');
    expect(target.contentPath).toBe('me/drive/root:/Shared%20Documents/Q1%20%23final/extract.csv:/content');
  });

  it('refuses a link that is not OneDrive or SharePoint, instead of asking Graph about it', () => {
    expect(() => resolveGraphTarget('https://example.com/data.csv')).toThrow(/does not look like/);
    expect(() => resolveGraphTarget('   ')).toThrow(/required/);
  });

  it('asks for a list id rather than guessing one from a display name', () => {
    expect(resolveListReference('sites/contoso.sharepoint.com,abc,def/lists/Inventory-1')).toEqual({
      siteId: 'contoso.sharepoint.com,abc,def',
      listId: 'Inventory-1',
    });
    // A browser URL does not contain the list id, and a display name is not unique enough to look one
    // up safely — two lists can have similar names.
    expect(() => resolveListReference('https://contoso.sharepoint.com/sites/Team/Lists/Inventory')).toThrow(
      /does not contain the list id/,
    );
  });

  it('asks only for read scopes', () => {
    // A consent prompt that cannot be mistaken for permission to change anything.
    expect(GRAPH_READ_SCOPES.every((s) => /\.Read\.All$/.test(s))).toBe(true);
    expect(GRAPH_READ_SCOPES.some((s) => /Write/i.test(s))).toBe(false);
  });
});

describe('fetching a file', () => {
  const target = resolveGraphTarget('drives/d1/items/i1');

  it('returns the bytes and the name Graph reports', async () => {
    const { request, asked } = stubGraph({
      'drives/d1/items/i1': { json: { name: 'extract.csv', size: 12 } },
      'drives/d1/items/i1/content': { body: Buffer.from('a,b\n1,2') },
    });
    const item = await fetchDriveItem(request, target);
    expect(item.name).toBe('extract.csv');
    expect(item.content.toString()).toBe('a,b\n1,2');
    // Metadata first, then content: the name is needed to know how to read the bytes.
    expect(asked).toEqual(['drives/d1/items/i1', 'drives/d1/items/i1/content']);
  });

  it('says what went wrong in terms somebody can act on', async () => {
    const missing = stubGraph({ 'drives/d1/items/i1': { status: 404 } });
    await expect(fetchDriveItem(missing.request, target)).rejects.toThrow(/shared with you/);

    const denied = stubGraph({ 'drives/d1/items/i1': { status: 403 } });
    await expect(fetchDriveItem(denied.request, target)).rejects.toThrow(/not allowed to read/);

    const broken = stubGraph({ 'drives/d1/items/i1': { status: 500 } });
    await expect(fetchDriveItem(broken.request, target)).rejects.toThrow(/returned 500/);
  });

  it('refuses a folder rather than downloading nothing useful', async () => {
    const folder = stubGraph({ 'drives/d1/items/i1': { json: { name: 'Reports', folder: {} } } });
    await expect(fetchDriveItem(folder.request, target)).rejects.toThrow(/points at a folder/);
  });
});

describe('reading a SharePoint list', () => {
  const ref = { siteId: 's1', listId: 'l1' };

  it('takes the union of every item, not the first item, as the header', async () => {
    // SharePoint omits a field entirely when it is empty. Taking row one's keys as the header would
    // silently drop every column that happened to be blank in that row.
    const { request } = stubGraph({
      'sites/s1/lists/l1': { json: { displayName: 'Inventory' } },
      'sites/s1/lists/l1/items': {
        json: {
          value: [
            { id: '1', fields: { Title: 'Widget', Quantity: 10 } },
            { id: '2', fields: { Title: 'Gadget', Quantity: 4, Notes: 'fragile' } },
          ],
        },
      },
    });
    const list = await fetchListRows(request, ref);
    expect(list.displayName).toBe('Inventory');
    expect(list.headers).toContain('Notes');
    expect(list.headers).toContain('Title');
    // The row that had no Notes gets a blank in that column rather than a shifted row.
    const notesAt = list.headers.indexOf('Notes');
    expect(list.rows[0][notesAt]).toBeNull();
    expect(list.rows[1][notesAt]).toBe('fragile');
  });

  it('flattens a person, lookup and multi-choice field instead of dropping it', async () => {
    const { request } = stubGraph({
      'sites/s1/lists/l1': { json: { displayName: 'Requests' } },
      'sites/s1/lists/l1/items': {
        json: {
          value: [
            {
              id: '1',
              fields: {
                Title: 'Laptop',
                Owner: { DisplayName: 'Ann Smith', Email: 'ann@example.com' },
                Category: { LookupValue: 'Hardware' },
                Tags: ['urgent', 'approved'],
                Approved: true,
              },
            },
          ],
        },
      },
    });
    const list = await fetchListRows(request, ref);
    const at = (name: string) => list.rows[0][list.headers.indexOf(name)];
    // The display value is what a person recognises, so that is what is kept.
    expect(at('Owner')).toBe('Ann Smith');
    expect(at('Category')).toBe('Hardware');
    expect(at('Tags')).toBe('urgent; approved');
    expect(at('Approved')).toBe(true);
  });

  it("leaves out SharePoint's own bookkeeping fields", async () => {
    const { request } = stubGraph({
      'sites/s1/lists/l1': { json: { displayName: 'L' } },
      'sites/s1/lists/l1/items': {
        json: {
          value: [
            {
              id: '1',
              fields: { Title: 'x', '@odata.etag': 'abc', ContentType: 'Item', LinkTitle: 'x' },
            },
          ],
        },
      },
    });
    const list = await fetchListRows(request, ref);
    expect(list.headers).toContain('Title');
    expect(list.headers).not.toContain('@odata.etag');
    expect(list.headers).not.toContain('ContentType');
    expect(list.headers).not.toContain('LinkTitle');
  });

  it('follows the continuation until the list is read', async () => {
    let page = 0;
    const request: GraphRequest = async (path) => {
      if (path === 'sites/s1/lists/l1') return { status: 200, json: { displayName: 'Big' } };
      page++;
      return page === 1
        ? {
            status: 200,
            json: {
              value: [{ id: '1', fields: { Title: 'a' } }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/s1/lists/l1/items?$skiptoken=x',
            },
          }
        : { status: 200, json: { value: [{ id: '2', fields: { Title: 'b' } }] } };
    };
    const list = await fetchListRows(request, ref);
    expect(list.rows).toHaveLength(2);
  });

  it('feeds the same inference a spreadsheet gets', async () => {
    // Graph's own column types are ignored on purpose: a list column declared Text routinely holds
    // numbers. The values decide, and the reasoning is reported the same way for both.
    const { request } = stubGraph({
      'sites/s1/lists/l1': { json: { displayName: 'Stock' } },
      'sites/s1/lists/l1/items': {
        json: {
          value: [
            { id: '1', fields: { Sku: 'A-1', Quantity: '10', Received: '2026-01-05' } },
            { id: '2', fields: { Sku: 'A-2', Quantity: '4', Received: '2026-02-11' } },
          ],
        },
      },
    });
    const list = await fetchListRows(request, ref);
    const inferred = inferTable('stock', list.displayName, list.headers, list.rows);
    const byName = new Map(inferred.columns.map((c) => [c.name, c]));
    expect(byName.get('Quantity')!.type).toBe('Integer');
    expect(byName.get('Received')!.type).toBe('DateTime');
    expect(byName.get('Sku')!.type).toBe('String');
  });

  it('reports a list it cannot see', async () => {
    const { request } = stubGraph({ 'sites/s1/lists/l1': { status: 404 } });
    await expect(fetchListRows(request, ref)).rejects.toThrow(/could not be found/);
  });
});
