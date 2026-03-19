/**
 * loop-cancel.ts — Nested loop cancel registration.
 *
 * Extracted from loop.ts to break the circular import:
 *   loop.ts ← loop-setup.ts ← loop-cancel.ts
 *
 * loop.ts imports fireNestedCancel and calls it in cancelLoop().
 * loop-setup.ts imports registerNestedCancel / clearNestedCancel.
 * loop-harness.ts does not import from loop.ts at all.
 */

type NestedCancelFn = () => void;
let nestedCancelFn: NestedCancelFn | null = null;

export function registerNestedCancel(fn: NestedCancelFn): void {
  nestedCancelFn = fn;
}

export function clearNestedCancel(): void {
  nestedCancelFn = null;
}

export function fireNestedCancel(): void {
  nestedCancelFn?.();
  nestedCancelFn = null;
}
