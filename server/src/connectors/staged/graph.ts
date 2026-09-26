import { DataverseError } from '../../dataverse/errors';

/**
 * Reading a spreadsheet out of OneDrive or SharePoint, and a SharePoint list, through Microsoft Graph.
 *
 * Neither is a database, so neither gets a live connector: both end up as rows in the staged model,
 * imported explicitly, with the drive item or list recorded as their provenance. What lives here is
 * only the part with logic — turning a link somebody pasted into a Graph request, and turning Graph's
 * answers into rows. The HTTP call itself is injected, so the translation can be tested without a
 * tenant and the untested surface is one function.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Delegated scopes needed to read files and lists.
 *
 * Read-only by name, not by intention: `Files.Read.All` and `Sites.Read.All` cannot write, so a
 * consent prompt cannot be mistaken for permission to change anything. They are requested only when
 * the feature is switched on, so a deployment that does not use it never asks for them.
 */
export const GRAPH_READ_SCOPES = [
  'https://graph.microsoft.com/Files.Read.All',
  'https://graph.microsoft.com/Sites.Read.All',
];

/** How the platform talks to Graph. Injected so the translation above it is testable. */
export type GraphRequest = (
  path: string,
  init?: { method?: string; accept?: 'json' | 'binary' },
) => Promise<{ status: number; json?: unknown; body?: Buffer }>;

// ---------------------------------------------------------------------------
// Turning a link into a Graph path
// ---------------------------------------------------------------------------

/**
 * Encodes a sharing link the way Graph's `/shares/{id}` endpoint requires.
 *
 * This is a specific algorithm and an easy one to get subtly wrong: base64url of the URL, `u!`
 * prefixed, with the padding removed. A wrong encoding does not fail loudly — it returns "item not
 * found" for a link that is perfectly valid, which sends somebody hunting for a permissions problem
 * that does not exist.
 *
 * https://learn.microsoft.com/graph/api/shares-get
 */
export function sharingLinkToShareId(url: string): string {
  const base64 = Buffer.from(url.trim(), 'utf8').toString('base64');
  const encoded = base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${encoded}`;
}

export interface GraphTarget {
  /** The Graph path that returns the item's metadata. */
  itemPath: string;
  /** The Graph path that returns its bytes. */
  contentPath: string;
  /** What to record as the provenance of the rows. */
  sourceRef: string;
}

/**
 * Works out which Graph endpoint a reference means.
 *
 * Three things people actually paste, and they need different endpoints:
 *
 * - a sharing link (`https://contoso-my.sharepoint.com/:x:/g/personal/...`) → `/shares/{id}/driveItem`
 * - a `drives/{id}/items/{id}` or `sites/{id}/drive/...` path already in Graph's own form
 * - a path inside the signed-in user's own OneDrive (`/Documents/extract.xlsx`)
 *
 * Guessing wrong between the first two is the common failure, so the discrimination is explicit
 * rather than a regex that happens to match.
 */
export function resolveGraphTarget(reference: string): GraphTarget {
  const ref = reference.trim();
  if (!ref) throw new DataverseError('VALIDATION', 'A file reference is required.', 400);

  // Already a Graph path: used as given, so a caller who knows exactly what they want is not
  // second-guessed.
  const graphPath = ref.replace(/^\/+/, '');
  if (/^(drives|sites|me|users|groups)\//i.test(graphPath)) {
    const base = graphPath.replace(/\/content$/i, '');
    return { itemPath: base, contentPath: `${base}/content`, sourceRef: ref };
  }

  if (/^https?:\/\//i.test(ref)) {
    if (!/\.sharepoint\.com|\.sharepoint\.[a-z]{2}|1drv\.ms|onedrive\.live\.com/i.test(ref)) {
      throw new DataverseError(
        'VALIDATION',
        'That does not look like a OneDrive or SharePoint link. Paste the sharing link from the file, or a Graph drives/... path.',
        400,
      );
    }
    const shareId = sharingLinkToShareId(ref);
    return {
      itemPath: `shares/${shareId}/driveItem`,
      contentPath: `shares/${shareId}/driveItem/content`,
      sourceRef: ref,
    };
  }

  // A path in the signed-in user's own drive. Each segment is encoded so a space or a `#` in a folder
  // name cannot change which item is addressed.
  const path = ref
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return {
    itemPath: `me/drive/root:/${path}`,
    contentPath: `me/drive/root:/${path}:/content`,
    sourceRef: ref,
  };
}

/** The file name Graph reports, so the import records what it actually read. */
export async function fetchDriveItem(
  request: GraphRequest,
  target: GraphTarget,
): Promise<{ name: string; size: number; content: Buffer }> {
  const meta = await request(target.itemPath);
  if (meta.status === 404) {
    throw new DataverseError(
      'NOT_FOUND',
      'That file could not be found, or the signed-in account cannot see it. Check the link and that it is shared with you.',
      404,
    );
  }
  if (meta.status === 403) {
    throw new DataverseError(
      'FORBIDDEN',
      'The signed-in account is not allowed to read that file. Graph reported access denied.',
      403,
    );
  }
  if (meta.status >= 400) {
    throw new DataverseError('SERVER_ERROR', `Microsoft Graph returned ${meta.status} for that file.`, 502);
  }
  const item = (meta.json ?? {}) as { name?: string; size?: number; folder?: unknown };
  if (item.folder) {
    throw new DataverseError(
      'VALIDATION',
      'That link points at a folder. Point it at a single CSV or workbook.',
      400,
    );
  }
  const content = await request(target.contentPath, { accept: 'binary' });
  if (content.status >= 400 || !content.body) {
    throw new DataverseError(
      'SERVER_ERROR',
      `Microsoft Graph returned ${content.status} when downloading that file.`,
      502,
    );
  }
  return { name: item.name ?? 'download', size: item.size ?? content.body.length, content: content.body };
}

// ---------------------------------------------------------------------------
// SharePoint lists
// ---------------------------------------------------------------------------

export interface GraphListReference {
  siteId: string;
  listId: string;
}

/**
 * Pulls a site and list id out of what somebody pasted.
 *
 * Accepts Graph's own `sites/{site}/lists/{list}` form and a browser URL of the shape
 * `https://contoso.sharepoint.com/sites/Team/Lists/Inventory`. The browser form cannot be resolved
 * without a lookup, so it is reported as needing the list's id rather than silently guessed at — a
 * list's display name is not its id, and there can be two lists with similar names.
 */
export function resolveListReference(reference: string): GraphListReference {
  const ref = reference.trim().replace(/^\/+/, '');
  const graph = ref.match(/^sites\/([^/]+)\/lists\/([^/?]+)/i);
  if (graph) return { siteId: graph[1], listId: graph[2] };
  throw new DataverseError(
    'VALIDATION',
    'Give the list as a Graph reference: sites/{site-id}/lists/{list-id}. A browser URL does not contain the list id, and a display name is not unique enough to look one up safely.',
    400,
  );
}

/** One page of list items, as Graph returns them. */
interface GraphListPage {
  value?: { id?: string; fields?: Record<string, unknown> }[];
  '@odata.nextLink'?: string;
}

/**
 * Reads a SharePoint list into a header row and rows, so it goes through exactly the same schema
 * inference a spreadsheet does.
 *
 * Graph's own column metadata is deliberately not used for typing. A list column declared "Text"
 * routinely holds numbers, and one declared "Number" routinely holds blanks — so the values decide,
 * the same way they do for a file, and the same reasoning is reported for both.
 */
export async function fetchListRows(
  request: GraphRequest,
  ref: GraphListReference,
  opts: { maxRows?: number } = {},
): Promise<{ headers: string[]; rows: (string | number | boolean | null)[][]; displayName: string }> {
  const maxRows = opts.maxRows ?? 100_000;
  const listMeta = await request(`sites/${ref.siteId}/lists/${ref.listId}`);
  if (listMeta.status === 404) {
    throw new DataverseError('NOT_FOUND', 'That list could not be found, or you cannot see it.', 404);
  }
  if (listMeta.status >= 400) {
    throw new DataverseError(
      'SERVER_ERROR',
      `Microsoft Graph returned ${listMeta.status} for that list.`,
      502,
    );
  }
  const displayName =
    ((listMeta.json ?? {}) as { displayName?: string; name?: string }).displayName ??
    ((listMeta.json ?? {}) as { name?: string }).name ??
    'List';

  const collected: Record<string, unknown>[] = [];
  let path: string | null = `sites/${ref.siteId}/lists/${ref.listId}/items?expand=fields&$top=200`;
  while (path && collected.length < maxRows) {
    const page = await request(path);
    if (page.status >= 400) {
      throw new DataverseError(
        'SERVER_ERROR',
        `Microsoft Graph returned ${page.status} while reading list items.`,
        502,
      );
    }
    const body = (page.json ?? {}) as GraphListPage;
    for (const item of body.value ?? []) {
      if (collected.length >= maxRows) break;
      collected.push({ ...(item.fields ?? {}), __itemId: item.id ?? '' });
    }
    const next = body['@odata.nextLink'];
    // The continuation is an absolute URL; the request function takes a path, so the base is removed.
    path = next ? next.replace(`${GRAPH_BASE}/`, '') : null;
  }

  // The union of every item's fields, because SharePoint omits a field entirely when it is empty —
  // taking the first item's keys as the header would drop every column that happened to be blank
  // in row one.
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of collected) {
    for (const key of Object.keys(item)) {
      if (IGNORED_LIST_FIELDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  const rows = collected.map((item) => headers.map((h) => flatten(item[h])));
  return { headers, rows, displayName };
}

/**
 * SharePoint's own bookkeeping fields. They describe the list item rather than the data somebody put
 * in it, and carrying them into a mapping is noise.
 */
const IGNORED_LIST_FIELDS = new Set([
  '@odata.etag',
  'ContentType',
  'Attachments',
  'Edit',
  'LinkTitleNoMenu',
  'LinkTitle',
  'ItemChildCount',
  'FolderChildCount',
  '_ComplianceFlags',
  '_ComplianceTag',
  '_ComplianceTagWrittenTime',
  '_ComplianceTagUserId',
  '_UIVersionString',
  'AppAuthor',
  'AppEditor',
]);

/**
 * One list field as a cell.
 *
 * A person field arrives as an object and a multi-choice field as an array. Both are flattened to
 * text rather than dropped: the value is real data somebody typed, and the transformation engine can
 * be pointed at it later.
 */
function flatten(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => String(flatten(v) ?? '')).join('; ');
  const record = value as Record<string, unknown>;
  // A lookup or person field: the display value is what a person recognises.
  const label = record.LookupValue ?? record.DisplayName ?? record.Title ?? record.Email ?? record.Label;
  if (typeof label === 'string' || typeof label === 'number') return label;
  return JSON.stringify(value);
}

/**
 * Checks whether this deployment can read files at all, and says what is missing when it cannot.
 *
 * The value here is not the happy path. It is that the first person to point the platform at a real
 * tenant gets told *which* of the four things went wrong — the feature is off, nobody consented, the
 * account lacks the scope, or Graph is simply unreachable — rather than a generic failure they then
 * have to bisect. Those four produce very different fixes and are easy to confuse.
 */
export async function probeGraphAccess(
  request: GraphRequest,
  kind: 'ONEDRIVE' | 'SHAREPOINT',
): Promise<{ ok: boolean; message: string; resolution: string | null }> {
  // `me/drive` needs Files.Read.All; `sites/root` needs Sites.Read.All. Probing the one the
  // connection actually uses means a missing scope is reported against the feature that needs it.
  const path = kind === 'SHAREPOINT' ? 'sites/root' : 'me/drive';
  let response: Awaited<ReturnType<GraphRequest>>;
  try {
    response = await request(path);
  } catch (err) {
    return {
      ok: false,
      message: `Microsoft Graph could not be reached: ${err instanceof Error ? err.message : 'unknown error'}`,
      resolution: 'Check that this deployment has outbound access to graph.microsoft.com.',
    };
  }

  if (response.status === 200) {
    const body = (response.json ?? {}) as { name?: string; displayName?: string; webUrl?: string };
    const label = body.displayName ?? body.name ?? body.webUrl ?? 'available';
    return { ok: true, message: `Reachable — ${label}`, resolution: null };
  }
  const error = ((response.json ?? {}) as { error?: { code?: string; message?: string } }).error;
  const code = error?.code ?? '';
  const detail = error?.message ?? `Graph returned ${response.status}`;

  if (response.status === 401) {
    return {
      ok: false,
      message: `Not signed in to Microsoft Graph: ${detail}`,
      resolution:
        'Sign out and in again so a Graph token is issued. If this deployment was only just switched on, consent has to be granted at sign-in.',
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      message: `Graph refused the request: ${detail}`,
      resolution:
        kind === 'SHAREPOINT'
          ? 'The signed-in account needs Sites.Read.All consented, and access to the site.'
          : 'The signed-in account needs Files.Read.All consented.',
    };
  }
  if (response.status === 404 && kind === 'ONEDRIVE') {
    return {
      ok: false,
      message: 'This account has no OneDrive.',
      resolution:
        'Use a SharePoint sharing link or a drives/{drive-id} path instead, or sign in with an account that has OneDrive.',
    };
  }
  return {
    ok: false,
    message: `${code ? `${code}: ` : ''}${detail}`,
    resolution: 'Check the Microsoft Graph permissions granted to this application.',
  };
}

/**
 * The live Graph call.
 *
 * Deliberately the only thing here that talks to the network, and deliberately thin: a token, a URL
 * and a response. Everything with a decision in it is above, where it can be tested without a tenant.
 */
export function graphRequester(accessToken: string): GraphRequest {
  return async (path, init) => {
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}/${path.replace(/^\/+/, '')}`;
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: init?.accept === 'binary' ? '*/*' : 'application/json',
      },
      // Graph redirects a content download to storage; following it is how the bytes arrive.
      redirect: 'follow',
    });
    if (init?.accept === 'binary') {
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, body: buffer };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  };
}
