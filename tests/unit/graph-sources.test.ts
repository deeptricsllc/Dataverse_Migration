import { describe, expect, it } from 'vitest';
import {
  probeGraphAccess,
  fetchDriveItem,
  fetchListRows,
  GRAPH_READ_SCOPES,
  listDriveChildren,
  listSiteLists,
  listSites,
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

describe('telling somebody what is actually wrong', () => {
  /**
   * The four things that go wrong here produce four different fixes, and they are easy to confuse:
   * the feature is off, nobody consented, the account lacks the scope, or Graph is unreachable. A
   * generic failure leaves the first person with a real tenant to bisect them.
   */
  it('names a missing consent separately from a missing permission', async () => {
    const unauthorized = stubGraph({
      'me/drive': {
        status: 401,
        json: { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } },
      },
    });
    const noToken = await probeGraphAccess(unauthorized.request, 'ONEDRIVE');
    expect(noToken.ok).toBe(false);
    expect(noToken.resolution).toMatch(/consent has to be granted at sign-in/i);

    const forbidden = stubGraph({
      'me/drive': {
        status: 403,
        json: { error: { code: 'accessDenied', message: 'Insufficient privileges.' } },
      },
    });
    const denied = await probeGraphAccess(forbidden.request, 'ONEDRIVE');
    expect(denied.ok).toBe(false);
    // A different fix: the scope, not the sign-in.
    expect(denied.resolution).toMatch(/Files\.Read\.All/);
  });

  it('probes the endpoint the connection actually needs', async () => {
    // Probing me/drive for a SharePoint list would report Files.Read.All missing when the real gap is
    // Sites.Read.All.
    const sites = stubGraph({ 'sites/root': { status: 403, json: { error: { message: 'no' } } } });
    const result = await probeGraphAccess(sites.request, 'SHAREPOINT');
    expect(sites.asked).toEqual(['sites/root']);
    expect(result.resolution).toMatch(/Sites\.Read\.All/);

    const drive = stubGraph({ 'me/drive': { status: 200, json: { name: 'OneDrive' } } });
    const ok = await probeGraphAccess(drive.request, 'ONEDRIVE');
    expect(drive.asked).toEqual(['me/drive']);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('OneDrive');
  });

  it('distinguishes an account with no OneDrive from a permissions problem', async () => {
    // A licensing question, not a consent one, and it has a different answer.
    const none = stubGraph({ 'me/drive': { status: 404, json: {} } });
    const result = await probeGraphAccess(none.request, 'ONEDRIVE');
    expect(result.message).toMatch(/no OneDrive/);
    expect(result.resolution).toMatch(/SharePoint sharing link/);
  });

  it('reports an unreachable Graph as unreachable', async () => {
    const broken: GraphRequest = async () => {
      throw new Error('getaddrinfo ENOTFOUND graph.microsoft.com');
    };
    const result = await probeGraphAccess(broken, 'ONEDRIVE');
    expect(result.ok).toBe(false);
    expect(result.resolution).toMatch(/outbound access/);
  });
});

/**
 * Browsing SharePoint and OneDrive.
 *
 * The decisions are here: which endpoint "all sites" means, which lists are plumbing and must not be
 * offered as datasets, and what reference a browsed file resolves to. All of it tested against a stubbed
 * Graph, for the same reason the rest of this file is — a tenant is not available to test against, and
 * the alternative is shipping code whose first run is somebody's production SharePoint.
 *
 * What this cannot prove is stated plainly rather than implied: these have never been executed against a
 * real Microsoft tenant. See docs/DATAVERSE_REAL_TENANT_READ_ONLY_CERTIFICATION.md for the same
 * distinction applied to Dataverse.
 */
describe('browsing a Microsoft connection', () => {
  it('asks Graph for every site when nothing is searched for', async () => {
    const graph = stubGraph({
      'sites?search=*': {
        json: {
          value: [
            {
              id: 'contoso.sharepoint.com,guid1,guid2',
              displayName: 'Claims Operations',
              webUrl: 'https://c/claims',
            },
            { id: 'contoso.sharepoint.com,guid3,guid4', name: 'Finance', webUrl: 'https://c/finance' },
          ],
        },
      },
    });
    const sites = await listSites(graph.request);
    // `search=*` is Graph's way of saying "all of them"; there is no other way to enumerate sites.
    expect(graph.asked).toEqual(['sites?search=*']);
    expect(sites.map((s) => s.displayName)).toEqual(['Claims Operations', 'Finance']);
    // The id is the comma-separated triple the list reference needs, carried through untouched.
    expect(sites[0]!.id).toBe('contoso.sharepoint.com,guid1,guid2');
  });

  it('narrows the search, because a tenant can have thousands of sites', async () => {
    const graph = stubGraph({ 'sites?search=claims': { json: { value: [] } } });
    await listSites(graph.request, 'claims');
    expect(graph.asked).toEqual(['sites?search=claims']);
  });

  it('says what is wrong when the account may not list sites', async () => {
    const graph = stubGraph({ 'sites?search=*': { status: 403, json: {} } });
    await expect(listSites(graph.request)).rejects.toThrow(/Sites.Read.All|cannot list/i);
  });

  it('offers the lists somebody keeps data in, and not the plumbing', async () => {
    const graph = stubGraph({
      'sites/site1/lists': {
        json: {
          value: [
            {
              id: 'l1',
              displayName: 'Claims',
              list: { template: 'genericList' },
              webUrl: 'https://c/claims',
            },
            {
              id: 'l2',
              displayName: 'Documents',
              list: { template: 'documentLibrary' },
              webUrl: 'https://c/d',
            },
            // Every SharePoint site carries a dozen of these. Offering them as datasets would bury the
            // two lists above them.
            { id: 'l3', displayName: 'Form Templates', list: { template: 'documentLibrary', hidden: true } },
            { id: 'l4', displayName: 'appdata', list: { hidden: true } },
          ],
        },
      },
    });
    const lists = await listSiteLists(graph.request, 'site1');
    expect(lists.map((l) => l.displayName)).toEqual(['Claims', 'Documents']);
    expect(lists[0]!.template).toBe('genericList');
    expect(lists[1]!.template).toBe('documentLibrary');
  });

  it('reads one level of a drive and resolves each item to a reference the importer takes', async () => {
    const graph = stubGraph({
      'me/drive/root/children': {
        json: {
          value: [
            { id: 'f1', name: 'Legacy', folder: { childCount: 3 }, parentReference: { driveId: 'd1' } },
            { id: 'x1', name: 'Customers.xlsx', size: 20_480, parentReference: { driveId: 'd1' } },
          ],
        },
      },
    });
    const items = await listDriveChildren(graph.request, 'me/drive');
    expect(items.map((i) => i.name)).toEqual(['Legacy', 'Customers.xlsx']);
    expect(items[0]!.isFolder).toBe(true);
    expect(items[1]!.isFolder).toBe(false);
    expect(items[1]!.size).toBe(20_480);
    /*
     * The same shape a pasted `drives/{id}/items/{id}` link resolves to, so browsing to a file and
     * pasting a link to it end in exactly the same import rather than two code paths that can disagree.
     */
    expect(items[1]!.reference).toBe('drives/d1/items/x1');
    expect(resolveGraphTarget(items[1]!.reference).itemPath).toBe('drives/d1/items/x1');
  });

  it('opens a folder by id rather than walking everything', async () => {
    const graph = stubGraph({
      'me/drive/items/f1/children': { json: { value: [{ id: 'x2', name: 'Orders.csv' }] } },
    });
    const items = await listDriveChildren(graph.request, 'me/drive', 'f1');
    expect(graph.asked).toEqual(['me/drive/items/f1/children']);
    expect(items.map((i) => i.name)).toEqual(['Orders.csv']);
  });

  it("reads a site's library rather than the signed-in user's own drive", async () => {
    const graph = stubGraph({ 'sites/site1/drive/root/children': { json: { value: [] } } });
    await listDriveChildren(graph.request, 'sites/site1/drive');
    expect(graph.asked).toEqual(['sites/site1/drive/root/children']);
  });

  it('reports a folder that is not there as not there', async () => {
    const graph = stubGraph({});
    await expect(listDriveChildren(graph.request, 'me/drive', 'gone')).rejects.toThrow(/could not be found/);
  });

  it('ignores a response that is not a collection rather than inventing rows from it', async () => {
    const graph = stubGraph({ 'sites?search=*': { json: { error: { code: 'nope' } } } });
    await expect(listSites(graph.request)).resolves.toEqual([]);
  });
});
