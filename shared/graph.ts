/**
 * What browsing a Microsoft connection returns.
 *
 * Shared because both halves of the product need the same shapes: the server resolves them from Microsoft
 * Graph, and the screen that lets somebody pick a site, a list or a file renders them. Kept here rather
 * than imported from the server so the web bundle never reaches across that boundary.
 */

export interface GraphSite {
  /** Graph's own site id — the triple that the list reference needs. */
  id: string;
  displayName: string;
  webUrl: string;
}

export interface GraphList {
  id: string;
  displayName: string;
  /** `genericList`, `documentLibrary`, … — what decides whether this holds items or files. */
  template: string | null;
  webUrl: string;
}

export interface GraphDriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  /** The reference the importer takes for this item. */
  reference: string;
}
