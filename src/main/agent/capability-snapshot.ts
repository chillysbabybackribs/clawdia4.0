/**
 * Capability Snapshot — Read-only diagnostic object for pre-LLM capability resolution.
 *
 * Built once per request from existing data (ExecutionPlan, AppProfile, desktop capabilities).
 * NOT injected into the prompt — the ExecutionPlan constraint already does that.
 * Used for:
 *   - Console logging (debugging routing decisions)
 *   - Optional IPC to renderer (future "routing inspector" panel)
 *   - Serializable audit trail
 */

import type { ExecutionPlan, AppProfile } from '../db/app-registry';

export interface CapabilitySnapshot {
  appId: string | null;
  appDetected: boolean;
  nativeCliAvailable: boolean;
  cliAnythingAvailable: boolean;   // pre-built harness exists in repo
  cliAnythingInstalled: boolean;   // harness binary is on PATH
  cliAnythingCommands: string[];   // known commands (empty if unknown)
  cliAnythingHasSkill: boolean;    // SKILL.md loaded into prompt
  a11yAvailable: boolean;
  rawGuiAvailable: boolean;        // xdotool installed
  dbusAvailable: boolean;
  preferredOrder: string[];        // e.g. ['cli_anything', 'programmatic', 'gui']
  selectedSurface: string;
  routingReason: string;
  resolvedAt: number;              // Date.now()
}

// Known pre-built harnesses (kept in sync with app-registry.ts PREBUILT_HARNESSES)
const KNOWN_PREBUILT = new Set([
  'gimp', 'blender', 'inkscape', 'libreoffice', 'audacity',
  'obs', 'kdenlive', 'shotcut', 'vlc', 'zoom', 'drawio',
  'adguardhome',
]);

/**
 * Build a capability snapshot from existing routing data.
 * All inputs are already computed by the pre-LLM setup phase in loop.ts.
 */
export function buildCapabilitySnapshot(
  appId: string | null,
  plan: ExecutionPlan | null,
  profile: AppProfile | null,
  systemCaps: { xdotool: boolean; dbus: boolean; a11y: boolean },
): CapabilitySnapshot {
  return {
    appId,
    appDetected: appId !== null,
    nativeCliAvailable: !!profile?.nativeCli,
    cliAnythingAvailable: !!profile?.cliAnything || KNOWN_PREBUILT.has(appId || ''),
    cliAnythingInstalled: profile?.cliAnything?.installed ?? false,
    cliAnythingCommands: profile?.cliAnything?.commands ?? [],
    cliAnythingHasSkill: !!profile?.cliAnything?.skillContent,
    a11yAvailable: systemCaps.a11y,
    rawGuiAvailable: systemCaps.xdotool,
    dbusAvailable: systemCaps.dbus,
    preferredOrder: plan?.allowedSurfaces ?? [],
    selectedSurface: plan?.selectedSurface ?? 'none',
    routingReason: plan?.reasoning ?? 'No routing performed — no app detected.',
    resolvedAt: Date.now(),
  };
}

/** Compact one-line log format for console output. */
export function formatSnapshotLog(snap: CapabilitySnapshot): string {
  if (!snap.appDetected) return '[Capability] No app detected — generic desktop task';
  const surfaces = snap.preferredOrder.map(s =>
    s === snap.selectedSurface ? `[${s}]` : s
  ).join(' → ');
  const cli = snap.cliAnythingInstalled
    ? `cli:installed(${snap.cliAnythingCommands.length} cmds${snap.cliAnythingHasSkill ? ', SKILL.md' : ''})`
    : snap.cliAnythingAvailable
      ? 'cli:available(not installed)'
      : 'cli:none';
  return `[Capability] ${snap.appId} | ${surfaces} | ${cli} | a11y:${snap.a11yAvailable} | gui:${snap.rawGuiAvailable}`;
}
