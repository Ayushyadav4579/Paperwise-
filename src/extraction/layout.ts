/**
 * Pure helpers used by the document extractor.
 *
 * PDF text is a bag of positioned glyph runs. Joining it with spaces (the old
 * behaviour) destroys question numbering and paragraph boundaries, which in
 * turn breaks question detection. These helpers rebuild real lines from the
 * item coordinates instead.
 *
 * Mathematical documents make this harder than ordinary prose:
 *
 * - Exponents and subscripts sit on a different baseline, so grouping strictly
 *   by y turns `m/s²` into two lines and can even move the `2` above the line it
 *   belongs to. Small runs are therefore attached to the nearest normal line
 *   and marked with `^` / `_` rather than becoming their own rows.
 * - Two-column papers put unrelated questions on the same baseline. A single
 *   wide gutter that runs down the page is detected and the page is read one
 *   column at a time.
 * - A table of numbers also uses wide gaps, so column detection additionally
 *   requires substantial prose on both sides.
 *
 * When the page cannot be reconstructed confidently, the output stays plain
 * text: losing structure is recoverable, inventing it is not.
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

type PositionedRun = { str: string; x: number; y: number; width: number; height: number };

function median(values: number[]): number {
  if (!values.length) return 10;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function positionedRuns(items: PdfTextItemLike[]): PositionedRun[] {
  const runs: PositionedRun[] = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    const x = Number(item.transform?.[4]);
    const y = Number(item.transform?.[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    runs.push({
      str: item.str,
      x,
      y,
      width: Math.abs(Number(item.width) || 0),
      height: Math.abs(Number(item.height) || 0),
    });
  }
  return runs;
}

type LineRow = {
  y: number;
  height: number;
  runs: PositionedRun[];
  order: number;
};

/** A wide, vertical whitespace corridor that separates two text columns. */
function findColumnGutter(runs: PositionedRun[], pageWidth: number): number | null {
  if (runs.length < 20) return null;
  const intervals = runs
    .map(run => [run.x, run.x + Math.max(run.width, 1)] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  for (let index = 0; index < merged.length - 1; index++) {
    const gapStart = merged[index][1];
    const gapEnd = merged[index + 1][0];
    const gapWidth = gapEnd - gapStart;
    const centre = (gapStart + gapEnd) / 2;
    if (gapWidth < Math.max(24, pageWidth * 0.055)) continue;
    if (centre < pageWidth * 0.3 || centre > pageWidth * 0.7) continue;

    const left = runs.filter(run => run.x + run.width <= gapStart + 0.5);
    const right = runs.filter(run => run.x >= gapEnd - 0.5);
    const prose = (list: PositionedRun[]) => list.filter(run => run.str.trim().length >= 15).length;
    const span = (list: PositionedRun[]) => {
      if (!list.length) return 0;
      const ys = list.map(run => run.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    const pageSpan = Math.max(1, span(runs));
    if (prose(left) < 8 || prose(right) < 8) continue;
    if (span(left) < pageSpan * 0.5 || span(right) < pageSpan * 0.5) continue;
    return centre;
  }
  return null;
}

/** Build visual rows from normal-size runs, then absorb small script runs. */
function buildRows(runs: PositionedRun[], baseHeight: number): LineRow[] {
  const rows: LineRow[] = [];
  const normal = runs.filter(run => run.height >= baseHeight * 0.82 || run.str.trim().length > 3);
  const small = runs.filter(run => !normal.includes(run));

  const place = (run: PositionedRun, tolerance: number, absorb: boolean) => {
    let best: LineRow | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const distance = Math.abs(row.y - run.y);
      if (distance > tolerance) continue;
      if (absorb) {
        const minX = Math.min(...row.runs.map(item => item.x)) - baseHeight;
        const maxX = Math.max(...row.runs.map(item => item.x + item.width)) + baseHeight;
        if (run.x < minX || run.x > maxX) continue;
      }
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (best) {
      best.runs.push(run);
      if (!absorb) best.y = median(best.runs.map(item => item.y));
      return;
    }
    rows.push({ y: run.y, height: Math.max(run.height, baseHeight), runs: [run], order: rows.length });
  };

  for (const run of normal) place(run, Math.max(1.6, baseHeight * 0.3), false);
  for (const run of small) place(run, Math.max(2.4, baseHeight * 0.65), true);
  return rows;
}

function joinRow(row: LineRow): string {
  const runs = [...row.runs].sort((left, right) => left.x - right.x || right.y - left.y);
  const lineHeight = Math.max(row.height, ...runs.map(run => run.height));
  let line = '';
  let cursor = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const gap = run.x - cursor;
    const raised = run.y - row.y >= lineHeight * 0.16 && run.height <= lineHeight * 0.92;
    const lowered = row.y - run.y >= lineHeight * 0.12 && run.height <= lineHeight * 0.95;
    const script = (raised || lowered) && /^[0-9A-Za-z+\-−=]+$/.test(run.str.trim()) && gap <= lineHeight * 0.2;
    const needsSpace =
      line.length > 0 && Number.isFinite(gap) && gap > Math.max(1.2, run.height * 0.3) && !/\s$/.test(line) && !/^\s/.test(run.str);
    if (needsSpace) {
      line += ' ';
    } else if (script && line.length > 0 && !/[\^_\s]$/.test(line)) {
      // Preserve an exponent/subscript relationship that the PDF encoded only
      // through geometry. `m/s` + raised `2` becomes `m/s^2`, not a stray line.
      line += raised ? '^' : '_';
    }
    line += run.str;
    const width = run.width > 0 ? run.width : run.str.length * lineHeight * 0.5;
    cursor = run.x + width;
  }
  return line.replace(/[ \t]+/g, ' ').trim();
}

function reconstructRuns(runs: PositionedRun[]): string[] {
  if (!runs.length) return [];
  const heights = runs.filter(run => run.str.trim() && run.height > 0).map(run => run.height);
  const baseHeight = median(heights.length ? heights : [10]);
  const pageWidth = Math.max(
    median(runs.map(run => run.x + run.width)) * 1.1,
    Math.max(...runs.map(run => run.x + run.width))
  );
  const gutter = findColumnGutter(runs, pageWidth);
  if (gutter === null) {
    return buildRows(runs, baseHeight)
      .sort((left, right) => right.y - left.y || left.order - right.order)
      .map(joinRow)
      .filter(Boolean);
  }

  const ys = runs.map(run => run.y);
  const yMax = Math.max(...ys);
  const ySpan = Math.max(1, yMax - Math.min(...ys));
  const headerLimit = yMax - ySpan * 0.12;
  const crossing = runs.filter(run => run.x < gutter && run.x + Math.max(run.width, 1) > gutter);
  const blocking = crossing.filter(run => run.y < headerLimit && run.y > yMax - ySpan * 0.92);
  if (blocking.length) {
    return buildRows(runs, baseHeight)
      .sort((left, right) => right.y - left.y || left.order - right.order)
      .map(joinRow)
      .filter(Boolean);
  }

  const header = reconstructRuns(crossing.filter(run => run.y >= headerLimit));
  const left = runs.filter(run => run.x + Math.max(run.width, 1) / 2 < gutter);
  const right = runs.filter(run => run.x + Math.max(run.width, 1) / 2 >= gutter);
  return [...header, ...reconstructRuns(left), ...reconstructRuns(right)];
}

/**
 * Group positioned text runs into visual lines, then join runs within a line
 * using the horizontal gap to decide whether a space is needed. Line breaks in
 * the source document are preserved as `\n`; exponent and subscript geometry is
 * preserved with `^` / `_`.
 */
export function reconstructPageLines(items: PdfTextItemLike[]): string {
  return reconstructRuns(positionedRuns(items)).join('\n');
}

/**
 * Count printed question labels using line structure only. Used to compare a
 * PDF text layer with its OCR pass: a result that finds more numbered
 * questions is more useful even when it is slightly shorter.
 */
export function countQuestionLabels(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(?:q(?:uestion)?\.?\s*|प्रश्न\s*)?\d{1,3}\s*[.)]\s+\S/i.test(line)) count++;
  }
  return count;
}

/**
 * A page can pass the readability check and still contain no recognisable
 * question numbering. When it also looks like a question paper, one OCR pass
 * is not enough evidence; the caller should try the adaptive second pass too.
 */
export function needsStructureRetry(text: string): boolean {
  if (countQuestionLabels(text) >= 2) return false;
  if (text.replace(/\s+/g, '').length < 400) return false;
  return /maximum\s+marks|general\s+instructions|answer\s+all\s+questions|\bsection\s+[a-d]\b/i.test(text);
}

/** True when `candidate` reconstructs at least as much paper structure. */
export function preferExtractedText(current: string, candidate: string): boolean {
  const candidateLabels = countQuestionLabels(candidate);
  const currentLabels = countQuestionLabels(current);
  if (candidateLabels !== currentLabels) return candidateLabels > currentLabels;
  return candidate.trim().length >= current.trim().length;
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
