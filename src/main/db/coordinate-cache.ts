/**
 * Coordinate Cache — Persistent cross-session GUI element position store.
 *
 * Eliminates orientation screenshots for known apps by remembering where
 * UI elements live (e.g. GIMP's File menu is always at 33,56).
 *
 * Schema: coordinate_cache table (migration v4 in database.ts)
 *   app        — normalized app name, e.g. "gimp"
 *   window_key — normalized window title substring, e.g. "gnu image"
 *   element    — semantic label, e.g. "File menu", "Export As button"
 *   x, y       — absolute screen coordinates
 *   confidence — 0.0–1.0 (decays on error, boosts on hit)
 *   hit_count  — how many times this entry was used successfully
 *   last_used  — ISO timestamp
 *
 * Staleness: entries older than STALE_DAYS are re-validated on next use.
 * Resolution guard: entries are tagged with screen resolution; if the
 * user changes resolution the cache is bypassed (coordinates would be wrong).
 */

import { getDb } from './database';

const STALE_DAYS = 7;
const MIN_CONFIDENCE = 0.3;   // below this, entry is ignored
const CONFIDENCE_BOOST = 0.1;
const CONFIDENCE_DECAY = 0.25; // subtracted on error

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedCoordinate {
  x: number;
  y: number;
  confidence: number;
  hitCount: number;
  lastUsed: string;
  isStale: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeApp(app: string): string {
  return app.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeWindowKey(windowTitle: string): string {
  // Strip dynamic parts like filenames — keep recognizable app-level words
  return windowTitle
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function normalizeElement(element: string): string {
  return element.toLowerCase().trim();
}

function isStale(lastUsed: string): boolean {
  const ms = Date.now() - new Date(lastUsed).getTime();
  return ms > STALE_DAYS * 24 * 60 * 60 * 1000;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a cached coordinate for an app/window/element triple.
 * Returns null if not found, below confidence threshold, or resolution mismatch.
 */
export function lookupCoordinate(
  app: string,
  windowTitle: string,
  element: string,
  currentResolution?: string,   // e.g. "1920x1080" — optional guard
): CachedCoordinate | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT x, y, confidence, hit_count, last_used, resolution
      FROM coordinate_cache
      WHERE app = ? AND window_key = ? AND element = ?
      LIMIT 1
    `).get(
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeElement(element),
    ) as any;

    if (!row) return null;

    // Resolution guard — if stored at a different resolution, skip
    if (currentResolution && row.resolution && row.resolution !== currentResolution) {
      console.log(`[CoordCache] Resolution mismatch for "${element}" (stored: ${row.resolution}, current: ${currentResolution}) — skipping`);
      return null;
    }

    if (row.confidence < MIN_CONFIDENCE) {
      console.log(`[CoordCache] Low confidence for "${element}" (${row.confidence.toFixed(2)}) — skipping`);
      return null;
    }

    return {
      x: row.x,
      y: row.y,
      confidence: row.confidence,
      hitCount: row.hit_count,
      lastUsed: row.last_used,
      isStale: isStale(row.last_used),
    };
  } catch (err: any) {
    console.warn(`[CoordCache] Lookup error: ${err.message}`);
    return null;
  }
}

/**
 * Store or update a coordinate entry.
 * On conflict (same app+window_key+element), updates x/y/confidence/last_used.
 */
export function storeCoordinate(
  app: string,
  windowTitle: string,
  element: string,
  x: number,
  y: number,
  confidence = 1.0,
  resolution?: string,
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO coordinate_cache (app, window_key, element, x, y, confidence, resolution, hit_count, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(app, window_key, element) DO UPDATE SET
        x          = excluded.x,
        y          = excluded.y,
        confidence = MIN(1.0, excluded.confidence + ${CONFIDENCE_BOOST}),
        resolution = excluded.resolution,
        hit_count  = hit_count + 1,
        last_used  = datetime('now')
    `).run(
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeElement(element),
      Math.round(x),
      Math.round(y),
      Math.min(1.0, confidence),
      resolution || null,
    );
    console.log(`[CoordCache] Stored "${element}" for ${app} @ (${x}, ${y})`);
  } catch (err: any) {
    console.warn(`[CoordCache] Store error: ${err.message}`);
  }
}

/**
 * Record that a cached coordinate was confirmed correct (boost confidence).
 */
export function confirmCoordinate(app: string, windowTitle: string, element: string): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE coordinate_cache
      SET confidence = MIN(1.0, confidence + ?),
          hit_count  = hit_count + 1,
          last_used  = datetime('now')
      WHERE app = ? AND window_key = ? AND element = ?
    `).run(
      CONFIDENCE_BOOST,
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeElement(element),
    );
  } catch (err: any) {
    console.warn(`[CoordCache] Confirm error: ${err.message}`);
  }
}

/**
 * Record that a cached coordinate was wrong (decay confidence).
 * If confidence drops below MIN_CONFIDENCE, the entry will be ignored on next lookup.
 */
export function invalidateCoordinate(app: string, windowTitle: string, element: string): void {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE coordinate_cache
      SET confidence = MAX(0.0, confidence - ?)
      WHERE app = ? AND window_key = ? AND element = ?
    `).run(
      CONFIDENCE_DECAY,
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeElement(element),
    );
    console.log(`[CoordCache] Decayed confidence for "${element}" (${app})`);
  } catch (err: any) {
    console.warn(`[CoordCache] Invalidate error: ${err.message}`);
  }
}

/**
 * Return all cached targets for an app/window as a prompt-injectable summary.
 * Used to pre-populate the LLM with known coordinates without a screenshot.
 */
export function getCachedTargetsSummary(app: string, windowTitle: string): string {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT element, x, y, confidence, hit_count, last_used
      FROM coordinate_cache
      WHERE app = ? AND window_key = ?
        AND confidence >= ?
      ORDER BY hit_count DESC, confidence DESC
      LIMIT 15
    `).all(
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      MIN_CONFIDENCE,
    ) as any[];

    if (rows.length === 0) return '';

    const staleCount = rows.filter(r => isStale(r.last_used)).length;
    const lines = rows.map(r => {
      const staleFlag = isStale(r.last_used) ? ' [stale]' : '';
      return `  "${r.element}" → (${r.x}, ${r.y}) conf=${(r.confidence * 100).toFixed(0)}% hits=${r.hit_count}${staleFlag}`;
    });

    return `[Cached UI Targets — ${rows.length} known${staleCount > 0 ? `, ${staleCount} stale` : ''}]\n${lines.join('\n')}`;
  } catch (err: any) {
    console.warn(`[CoordCache] Summary error: ${err.message}`);
    return '';
  }
}

/**
 * Upsert alias — same as storeCoordinate but with a name that reads
 * naturally at the call site when updating an existing entry.
 */
export function upsertCoordinate(
  app: string,
  windowTitle: string,
  element: string,
  x: number,
  y: number,
  confidence = 1.0,
  resolution?: string,
): void {
  storeCoordinate(app, windowTitle, element, x, y, confidence, resolution);
}

/**
 * Evict / hard-delete an entry (use when a click fails and we want
 * to force re-discovery rather than just decaying confidence).
 */
export function evictCoordinate(app: string, windowTitle: string, element: string): void {
  try {
    const db = getDb();
    db.prepare(`
      DELETE FROM coordinate_cache
      WHERE app = ? AND window_key = ? AND element = ?
    `).run(
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeElement(element),
    );
    console.log(`[CoordCache] Evicted "${element}" for ${app}`);
  } catch (err: any) {
    console.warn(`[CoordCache] Evict error: ${err.message}`);
  }
}

/**
 * Load all cached coordinates for an app/window into a knownTargets-style
 * Record so desktop-executors can bulk-populate UIState without knowing
 * about the DB internals.
 *
 * Returns the number of entries loaded.
 */
export function warmUIStateFromCache(
  knownTargets: Record<string, { x: number; y: number; confidence: number; discoveredAt: number }>,
  app: string,
  windowTitle = '',
): number {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT element, x, y, confidence
      FROM coordinate_cache
      WHERE app = ?
        AND (window_key = ? OR ? = '')
        AND confidence >= ?
      ORDER BY hit_count DESC, confidence DESC
      LIMIT 20
    `).all(
      normalizeApp(app),
      normalizeWindowKey(windowTitle),
      normalizeWindowKey(windowTitle),
      MIN_CONFIDENCE,
    ) as Array<{ element: string; x: number; y: number; confidence: number }>;

    let loaded = 0;
    for (const row of rows) {
      const existing = knownTargets[row.element];
      if (!existing || existing.confidence < row.confidence) {
        knownTargets[row.element] = {
          x: row.x,
          y: row.y,
          confidence: row.confidence,
          discoveredAt: Date.now(),
        };
        loaded++;
      }
    }
    return loaded;
  } catch (err: any) {
    console.warn(`[CoordCache] warmUIStateFromCache error: ${err.message}`);
    return 0;
  }
}

/**
 * Prune entries: remove entries with confidence=0 or older than STALE_DAYS*4.
 * Call periodically (e.g. every 20 conversations).
 */
export function pruneCoordinateCache(): void {
  try {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM coordinate_cache
      WHERE confidence <= 0
         OR last_used < datetime('now', '-${STALE_DAYS * 4} days')
    `).run();
    if (result.changes > 0) {
      console.log(`[CoordCache] Pruned ${result.changes} stale entries`);
    }
  } catch (err: any) {
    console.warn(`[CoordCache] Prune error: ${err.message}`);
  }
}
