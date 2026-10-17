/**
 * Loads a canvas's preview images through one queue: screens in view first, a
 * few at a time, and everything still pending cancelled when the canvas goes
 * away. An `<img>` taken off the page keeps downloading, so a canvas left
 * behind would otherwise keep the server capturing screens nobody sees.
 */

import { useEffect, useState } from "react";

/** Overviews of screens in view, then their sharp tiles, then everything else. */
export const PREVIEW_PRIORITY = { near: 0, tile: 1, far: 2 } as const;
export type PreviewPriority = (typeof PREVIEW_PRIORITY)[keyof typeof PREVIEW_PRIORITY];

interface Entry {
  readonly url: string;
  priority: PreviewPriority;
  readonly listeners: Set<(objectUrl: string | null) => void>;
  controller: AbortController | null;
  result: string | null | undefined;
}

export class PreviewLoader {
  private readonly entries = new Map<string, Entry>();
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly fetchImage: (url: string, signal: AbortSignal) => Promise<Blob> = (
      url,
      signal,
    ) =>
      fetch(url, { signal }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      }),
  ) {}

  /**
   * Asks for `url`; `onDone` gets an object URL, or null when it could not be
   * loaded. Returns a function that drops the request, cancelling it if no
   * one else wants the same image.
   */
  load(
    url: string,
    priority: PreviewPriority,
    onDone: (objectUrl: string | null) => void,
  ): () => void {
    let entry = this.entries.get(url);
    if (entry === undefined) {
      entry = { url, priority, listeners: new Set(), controller: null, result: undefined };
      this.entries.set(url, entry);
    } else if (priority < entry.priority) {
      entry.priority = priority;
    }
    if (entry.result !== undefined) {
      onDone(entry.result);
      return () => {};
    }
    entry.listeners.add(onDone);
    this.pump();
    const current = entry;
    return () => {
      current.listeners.delete(onDone);
      // After the current commit, so a screen that re-asks with another
      // priority keeps its download instead of starting it over.
      queueMicrotask(() => {
        if (current.listeners.size > 0 || current.result !== undefined) return;
        if (this.entries.get(url) !== current) return;
        current.controller?.abort();
        this.entries.delete(url);
      });
    };
  }

  /** Cancels everything pending and frees every loaded image. */
  clear() {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.result) URL.revokeObjectURL(entry.result);
    }
    this.entries.clear();
  }

  private pump() {
    while (this.running < this.concurrency) {
      let next: Entry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.result !== undefined || entry.controller !== null) continue;
        // The newest of a priority goes first: it is what the view shows now.
        if (next === undefined || entry.priority <= next.priority) next = entry;
      }
      if (next === undefined) return;
      this.start(next);
    }
  }

  private start(entry: Entry) {
    const controller = new AbortController();
    entry.controller = controller;
    this.running += 1;
    this.fetchImage(entry.url, controller.signal)
      .then((blob) => (controller.signal.aborted ? null : URL.createObjectURL(blob)))
      .catch(() => null)
      .then((objectUrl) => {
        this.running -= 1;
        if (controller.signal.aborted) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        } else {
          entry.result = objectUrl;
          entry.controller = null;
          for (const listener of entry.listeners) listener(objectUrl);
          entry.listeners.clear();
        }
        this.pump();
      });
  }
}

/**
 * The loaded image for `url`: an object URL, null when it failed, or
 * undefined while it loads.
 */
export function usePreviewImage(
  loader: PreviewLoader,
  url: string | null,
  priority: PreviewPriority,
): string | null | undefined {
  const [result, setResult] = useState<{ url: string; image: string | null } | null>(null);
  useEffect(() => {
    if (url === null) return;
    return loader.load(url, priority, (image) => setResult({ url, image }));
  }, [loader, url, priority]);
  if (url === null) return null;
  return result !== null && result.url === url ? result.image : undefined;
}

// One queue for the whole app: a couple of requests at a time, after a pause,
// so the screens someone is looking at are always fetched first.
const PREWARM_CONCURRENCY = 1;
export const PREWARM_DELAY_MS = 3_000;
const prewarmed = new Set<string>();
const prewarmQueue: Array<string> = [];
let prewarmRunning = 0;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let prewarmHeld = false;

export function queuePreviewPrewarm(key: string, url: string) {
  if (prewarmed.has(key)) return;
  prewarmed.add(key);
  prewarmQueue.push(url);
  if (!prewarmHeld) prewarmTimer ??= setTimeout(drainPrewarmQueue, PREWARM_DELAY_MS);
}

/**
 * Holds off new captures until the canvas has been still for a while: a
 * capture takes a whole CPU core for a second or two, which a zoom or pan
 * on a smaller machine feels.
 */
export function holdPreviewPrewarm(moving: boolean) {
  prewarmHeld = moving;
  if (prewarmTimer !== null) clearTimeout(prewarmTimer);
  prewarmTimer = moving ? null : setTimeout(drainPrewarmQueue, PREWARM_DELAY_MS);
}

function drainPrewarmQueue() {
  prewarmTimer = null;
  startPrewarms();
}

function startPrewarms() {
  if (prewarmHeld || prewarmTimer !== null) return;
  while (prewarmRunning < PREWARM_CONCURRENCY && prewarmQueue.length > 0) {
    const url = prewarmQueue.shift()!;
    prewarmRunning += 1;
    void fetch(url, { priority: "low" })
      .then((response) => response.arrayBuffer())
      .catch(() => undefined)
      .finally(() => {
        prewarmRunning -= 1;
        startPrewarms();
      });
  }
}
