// Plain-text formatting for custom metadata cells (R17-R24).
//
// Output is always a JS string placed as a React text child. No HTML, Markdown,
// link detection or regex evaluation happens here or in the cell.

export const PREVIEW_LIMIT = 80;
export const TOOLTIP_LIMIT = 2000;
export const EMPTY_TEXT = "-";
// Leads the tooltip, so a scrolled tooltip still shows it (AC8).
const TRUNCATED_PREFIX = "[truncated] ";
const ELLIPSIS = "…";
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]+/g;

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

// Grapheme clusters keep flags and ZWJ emoji whole; without Intl.Segmenter,
// code points still never split a surrogate pair.
function* graphemeClusters(text) {
  if (!graphemeSegmenter) {
    yield* text;
    return;
  }
  for (const { segment } of graphemeSegmenter.segment(text)) yield segment;
}

// Return the first `limit` clusters when `text` has more than that; otherwise
// return null. Iteration stops after the extra cluster, so oversized clusters
// are preserved without turning the logical limit into a UTF-16 limit.
function headIfLonger(text, limit) {
  const head = [];
  for (const cluster of graphemeClusters(text)) {
    if (head.length === limit) return head;
    head.push(cluster);
  }
  return null;
}

function stringify(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

/**
 * @returns {{ text: string, full: string|null, truncated: boolean }}
 *   `text` is the single-line cell preview, `full` the tooltip body (null when
 *   the value is empty) and `truncated` whether either limit applied.
 */
export function formatMetadataValue(value) {
  if (value === undefined || value === null || value === "") {
    return { text: EMPTY_TEXT, full: null, truncated: false };
  }

  const collapsed = stringify(value).replace(CONTROL_RE, " ").trim();
  if (collapsed === "") {
    return { text: EMPTY_TEXT, full: null, truncated: false };
  }

  // Limits count grapheme clusters, so a cut never splits a character.
  let text = collapsed;
  let full = collapsed;
  let truncated = false;

  const previewHead = headIfLonger(collapsed, PREVIEW_LIMIT);
  if (previewHead) {
    text = `${previewHead.slice(0, PREVIEW_LIMIT - 1).join("")}${ELLIPSIS}`;
    truncated = true;
  }
  const tooltipHead = headIfLonger(collapsed, TOOLTIP_LIMIT);
  if (tooltipHead) {
    full = `${TRUNCATED_PREFIX}${tooltipHead.join("")}`;
    truncated = true;
  }

  return { text, full, truncated };
}

/**
 * Read exactly `metadata[name]` as an own property of a plain object. No
 * prototype walk, no nested-path interpretation (R9/AC9).
 */
export function readMetadataValue(metadata, name) {
  if (Object.prototype.toString.call(metadata) !== "[object Object]") {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(metadata, name)
    ? metadata[name]
    : undefined;
}
