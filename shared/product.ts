/**
 * What the product is called, in one place.
 *
 * "Data Analysis & Migration Platform" is a category rather than a name — it cannot be searched
 * for, put in a purchase order or said out loud twice the same way. A real name is coming, and it
 * was written into eleven files by hand, so renaming meant finding all eleven and hoping.
 *
 * Two exceptions that cannot import this and are listed here so they are not forgotten:
 *   - web/index.html — the <title> the browser shows before any script runs.
 *   - README.md — the heading of the repository itself.
 */
export const PRODUCT_NAME = 'Data Analysis & Migration Platform';

/** The company behind it. Separate from the product: one may be renamed without the other. */
export const VENDOR_NAME = 'DeepTrics';

/** The sidebar's second line, and the shortest honest description of what it does. */
export const PRODUCT_SHORT_NAME = 'Analysis & Migration';

/** For a sentence that needs both, e.g. the footer and the terms. */
export const PRODUCT_FULL_NAME = `${PRODUCT_NAME} · by ${VENDOR_NAME}`;
