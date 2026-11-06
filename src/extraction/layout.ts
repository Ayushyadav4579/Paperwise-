/**
 * Pure helpers used by the document extractor.
 *
 * PDF text is a bag of positioned glyph runs. Joining it with spaces (the old
 * behaviour) destroys question numbering and paragraph boundaries, which in
 * turn breaks question detection. These helpers rebuild real lines from the
 * item coordinates instead.
 */

export type PdfTextItemLike = {
  str: string;
  /** [a, b, c, d, x, y] in PDF user space. */
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

export type TextQuality = 'good' | 'partial' | 'poor';

const PAGE_MARKER = /^---\s*page\s+(\d+)\s*---$/i;

/**
 * Group positioned text runs into visual lines, then join runs within a line
 * using the horizontal gap to decide whether a space is needed. Line breaks in
 * the source document are preserved as `\n`.
 */
export function reconstructPageLines(items: PdfTextItemLike[]): string {
  const usable = items.filter(item => typeof item.str === 'string' && item.str.length > 0);
  if (!usable.length) return '';

  type Row = { y: number; items: PdfTextItemLike[]; order: number };
  const rows: Row[] = [];

  for (let index = 0; index < usable.length; index++) {
    const item = usable[index];
    const y = Number(item.transform[5]);
    if (!Number.isFinite(y)) continue;
    const tolerance = Math.max(1.6, Math.abs(Number(item.height) || 0) * 0.45);
    // Search the most recent rows first: PDF text order is usually close to
    // visual order, so this stays linear for large pages.
    let row: Row | undefined;
    for (let back = rows.length - 1; back >= Math.max(0, rows.length - 6); back--) {
      if (Math.abs(rows[back].y - y) <= tolerance) {
        row = rows[back];
        break;
      }
    }
    if (!row) {
      row = { y, items: [], order: index };
      rows.push(row);
    }
    row.items.push(item);
  }

  rows.sort((left, right) => {
    if (Math.abs(right.y - left.y) > 0.5) return right.y - left.y;
    return left.order - right.order;
  });

  const lines: string[] = [];
  for (const row of rows) {
    row.items.sort((left, right) => Number(left.transform[4]) - Number(right.transform[4]));
    let line = '';
    let cursor = Number.NEGATIVE_INFINITY;
    let previousHeight = 10;
    for (const item of row.items) {
      const x = Number(item.transform[4]);
      const height = Math.abs(Number(item.height) || 0) || previousHeight;
      const gap = x - cursor;
      if (
        line &&
        Number.isFinite(gap) &&
        gap > Math.max(1.2, height * 0.3) &&
        !/\s$/.test(line) &&
        !/^\s/.test(item.str)
      ) {
        line += ' ';
      }
      line += item.str;
      const width = Math.abs(Number(item.width) || 0);
      cursor = x + (Number.isFinite(width) && width > 0 ? width : 0);
      previousHeight = height;
    }
    const trimmed = line.replace(/[ \t]+/g, ' ').trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines.join('\n');
}

/** Trim/normalise a page of extracted text without destroying line breaks. */
export function normaliseExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Judge whether OCR/text extraction produced usable content. This is
 * intentionally conservative: a page with a handful of stray characters must
 * not be presented as successfully read.
 */
export function assessTextQuality(text: string): TextQuality {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 8) return 'poor';
  // Devanagari vowel signs and other combining marks are \p{M}, not \p{L}.
  // Excluding them scored a perfectly read Hindi page as "partial" and would
  // have pushed clean Hindi scans through the OCR second pass needlessly.
  const alphanumeric = (text.match(/[\p{L}\p{N}\p{M}]/gu) || []).length;
  const readable = alphanumeric / compact.length;
  const words = text.split(/\s+/).filter(word => /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}]{1,}/u.test(word)).length;
  if (compact.length >= 40 && readable >= 0.72 && words >= 8) return 'good';
  if (compact.length >= 24 && readable >= 0.5 && words >= 4) return 'partial';
  return 'poor';
}

export type PageBoundary = { page: number; text: string };

/**
 * Join pages with explicit markers so downstream code can report which page a
 * problem came from and so page boundaries survive question detection.
 */
export function joinPages(pages: PageBoundary[]): string {
  const readable = pages.filter(page => page.text.trim().length > 0);
  if (!readable.length) return '';
  if (readable.length === 1 && pages.length === 1) return normaliseExtractedText(readable[0].text);
  return pages
    .map(page => {
      const body = normaliseExtractedText(page.text);
      return body ? `--- Page ${page.page} ---\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** Remove page markers when plain text is needed (markers are metadata). */
export function stripPageMarkers(text: string): string {
  return text
    .split('\n')
    .filter(line => !PAGE_MARKER.test(line.trim()))
    .join('\n');
}

export function pageNumberFromMarker(line: string): number | null {
  const match = line.trim().match(PAGE_MARKER);
  return match ? Number(match[1]) : null;
}

// Pages are read one at a time and their canvases released before the next
// page, so the limit is driven by time rather than memory. 120 pages is about
// a full board paper plus its answer booklet, and 600k characters covers that
// at roughly 2,500 characters a page.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 120;
export const MAX_TEXT_CHARS = 600_000;

export const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g|webp|gif|bmp|tiff?|heic|heif|txt|md|csv)$/i;

/** Validate an upload before any expensive work starts. Returns a message or null. */
export function validateUpload(file: File): string | null {
  const name = file.name || 'file';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
  const isImage =
    file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(name);
  const isText = file.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(name);
  if (!isPdf && !isImage && !isText) {
    return `${name} is not a supported file. Use a PDF, photo, or text file.`;
  }
  if (file.size <= 0) return `${name} is empty.`;
  if (file.size > MAX_FILE_BYTES) {
    return `${name} is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB. Compress it or upload fewer pages.`;
  }
  if (!ACCEPTED_EXTENSIONS.test(name) && !isPdf && !isImage && !isText) {
    return `${name} has an unsupported extension.`;
  }
  return null;
}
