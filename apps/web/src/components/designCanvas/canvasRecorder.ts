/**
 * Diagnostic readings from the design canvas: gestures, zoom, live pages and
 * what sits under the cursor. Each one is a console line with a fixed prefix;
 * the desktop app copies those lines to logs/canvas-recorder.ndjson so a
 * misbehaving canvas can be studied after the fact.
 */

export const CANVAS_RECORDER_PREFIX = "[canvas-recorder] ";

export function recordCanvas(event: string, data: Record<string, unknown> = {}) {
  console.info(`${CANVAS_RECORDER_PREFIX}${JSON.stringify({ at: Date.now(), event, ...data })}`);
}

/** A short name for an element: tag, frame key or ARIA label, and a few classes. */
export function describeElement(element: EventTarget | Element | null): string {
  if (!(element instanceof Element)) return String(element);
  const key = element.closest("[data-frame-key]")?.getAttribute("data-frame-key");
  const label = element.getAttribute("aria-label");
  const classes = [...element.classList].slice(0, 4).join(".");
  return [
    element.tagName.toLowerCase(),
    classes ? `.${classes}` : "",
    label ? `[${label}]` : "",
    key ? ` in ${key}` : "",
  ].join("");
}
