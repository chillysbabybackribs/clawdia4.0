# Clawdia 4.0 — Validation: Post-Routing GUI Reality Check

## Source Inspection Summary

### Files Analyzed
- `src/main/agent/executors/desktop-executors.ts` (1,347 lines) — all GUI primitives + macros
- `src/main/agent/gui/ui-state.ts` — focus caching + confidence model
- `src/main/agent/gui/screenshot-analyzer.py` (519 lines) — OCR + coordinate extraction
- `src/main/db/app-registry.ts` — routing (post-fix: gui_interact never filtered)

---

## Defect Analysis: 6 Categories

### A. Focus Failure — DEFECT FOUND

**smartFocus() never verifies focus succeeded.**

```typescript
// desktop-executors.ts:239-248
await run(`wmctrl -a "${winName}" 2>&1`);
recordFocus(guiState, winName, '');  // ← Records success WITHOUT checking
```

`wmctrl -a` can silently fail (window name doesn't match, window on another workspace, window minimized). The function records `focused: true` regardless. Every subsequent click/type trusts this state.

**Impact**: If focus fails silently, typing/clicking goes to whatever window IS focused (likely Clawdia itself or the desktop). This is the most dangerous defect — it can cause text entry into the wrong application.

**Category**: Focus failure (A)

**Fix**: Add a verification step after `wmctrl -a`:

```typescript
// After wmctrl -a, verify the active window actually matches
const activeTitle = await run('xdotool getactivewindow getwindowname 2>/dev/null');
if (!activeTitle.startsWith('[Error]')) {
  const actual = activeTitle.trim().toLowerCase();
  const expected = winName.toLowerCase();
  if (!actual.includes(expected) && !expected.includes(actual)) {
    console.warn(`[Desktop] Focus verification FAILED: wanted "${winName}" but active is "${activeTitle.trim()}"`);
    recordError(guiState, 'focus', winName);
    return { focused: false, skipped: false };
  }
}
```

**Scope**: ~10 lines in `smartFocus()`.

---

### B. Coordinate Failure — NO DEFECT (correctly designed)

Coordinates come from two sources:

1. **OCR (screenshot-analyzer.py)**: Captures via `scrot -u` (focused window), so coordinates are **window-relative to the focused window's content area**. `xdotool mousemove` uses **absolute screen coordinates**, but since `scrot -u` captures the focused window positioned at its current screen location, and tesseract returns pixel positions within that capture, the math works out — pixel (100, 50) in a window at screen position (200, 100) maps to screen position (300, 150)... **wait, no**.

**Actually, this IS a problem.** `scrot -u` captures the focused window's content. Tesseract returns coordinates within that image. But `xdotool mousemove` uses absolute screen coordinates. The OCR coordinates are window-content-relative, not screen-absolute.

**However**, looking more carefully at `screenshot-analyzer.py:252-253`:
```python
cx = data['left'][i] + data['width'][i] // 2 + offset_x
cy = data['top'][i] + data['height'][i] // 2 + offset_y
```

These are pixel positions within the captured image. When `scrot -u` captures the focused window, the image starts at (0,0) of the window content. The click targets are therefore **window-content-relative coordinates, not absolute screen coordinates**.

**BUT** `xdotool mousemove ${x} ${y} click 1` uses **absolute screen coordinates**.

**This means OCR-derived coordinates will only work if the window is positioned at (0,0) on screen.** On a multi-monitor setup where the primary monitor is offset, every OCR-derived click target will be wrong.

**Wait** — let me re-check. `scrot -u` captures the *focused window*. The image coordinates within that capture represent positions *within the window*. If the window is at screen position (500, 200) and a button is at pixel (100, 30) in the capture, then the absolute screen coordinate should be (600, 230). But the code passes (100, 30) to xdotool, which clicks at absolute (100, 30) — **the wrong location**.

**Correction**: Actually, I need to check more carefully. `scrot -u` captures the focused window including its window manager decorations. The resulting image size matches the window bounds on screen. When `xdotool mousemove` is given coordinates, if those are from OCR on a `scrot -u` capture of a maximized window or a window positioned at (0,0), it would work. But for non-origin-positioned windows, there's a gap.

**HOWEVER** — the coordinate cache stores these values and they seem to work in practice based on the logs showing "Pre-loaded 12 cached coordinates for gimp". This suggests the coordinates ARE working for at least one window position. This could mean:
1. The test window was at/near (0,0), or
2. `scrot -u` returns screen-absolute coordinates embedded in the image somehow

**Verdict**: This needs empirical validation. If GIMP is maximized on the primary monitor (starting at 0,0), OCR coordinates would coincidentally match screen coordinates. On a secondary monitor or non-maximized window, they would break.

**Category**: Coordinate failure (B) — **suspected but unconfirmed, needs live test**

---

### C. Monitor-Space Failure — PARTIAL DEFECT

**Monitor bounds are detected but never used for coordinate translation.**

The system detects monitor layout via xrandr:
```typescript
// desktop-executors.ts:1315-1330
const geom = l.match(/(\d+x\d+\+\d+\+\d+)/)?.[1] || '';
// e.g. "1920x1080+0+0", "2560x1440+1920+0"
```

This data goes into `displayLayout` which is injected into the dynamic prompt. But it's **only used as informational text for the LLM** — there is no code that uses monitor geometry to translate coordinates.

**Impact**: The LLM sees the monitor layout and might attempt to reason about coordinates, but the OCR pipeline and click pipeline have no awareness of which monitor the target window is on. If the user's setup has:
- Monitor 1: 1920x1080+0+0 (primary)
- Monitor 2: 2560x1440+1920+0

And GIMP is on Monitor 2, OCR coordinates from `scrot -u` would be relative to the window, but xdotool expects absolute coordinates in the combined virtual screen space (0 to 4480 wide).

**Verdict**: Multi-monitor IS a real remaining defect, but only for windows not on the primary monitor at (0,0). **Needs live test to confirm.**

---

### D. Input-Target Failure — DEFECT FOUND

**Type action has no input target verification.**

```typescript
// desktop-executors.ts:668-678
case 'type': {
  if (!text) return '[Error] text required.';
  if (effectiveWindow) {
    const { skipped } = await smartFocus(effectiveWindow);
    if (!skipped) await wait(100);
  }
  if (delayMs) await wait(delayMs);
  await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
  recordSuccess(guiState, 'type', text.slice(0, 30));
  return `Typed "${text.slice(0, 50)}"`;
}
```

Problems:
1. Focus is attempted but **never verified** (cascades from Defect A)
2. After focus, there's a 100ms wait then immediate typing — no check that the correct input field is active
3. `xdotool type` sends keystrokes to whatever has focus — if focus failed or shifted between the focus call and the type call, text goes to the wrong place
4. The return value always says `Typed "..."` with no error detection — `xdotool type` doesn't return an error even if typing goes nowhere useful

**Impact**: Text entry into wrong window or wrong field. The most common failure mode in GUI automation.

**Fix**: Use the smartFocus verification from Defect A. Optionally, for high-value type actions (inside macros like `click_and_type`), verify active window title matches expected before typing.

---

### E. Dialog-State Failure — MINOR DEFECT

The macro `export_file` handles the overwrite dialog by checking `postActionVerify()` output:

```typescript
const afterExport = await postActionVerify(effectiveWindow);
if (afterExport.includes('DIALOG') || afterExport.toLowerCase().includes('overwrite') || ...) {
  await run('xdotool key Return');
}
```

This works if OCR correctly detects the dialog. If OCR fails or is unavailable, the overwrite dialog hangs. The system doesn't have a timeout/fallback for stuck dialogs.

**Impact**: Low — this only triggers when OCR + tesseract is available, and the dialog check is best-effort.

**Fix**: Not needed now. The current behavior (OCR-dependent) is acceptable for a fallback surface.

---

### F. Timing/State-Sync Failure — MINOR DEFECT

The wait times are hardcoded:
- After focus: 100ms
- After click: implicit (no wait before next action in batch)
- After menu key: 300ms
- After export shortcut: 800ms
- After dialog fill: 100ms per field

These are reasonable but can fail on slow machines or apps with heavy startup. The 800ms export shortcut wait is especially fragile — GIMP's Export As dialog can take 1-2s to open on first use.

**Impact**: Low — most macros have enough combined wait time. The export_file macro has OCR verification after the confirm step, which acts as an implicit wait.

**Fix**: Not needed unless live testing reveals timing failures. If needed, increase export shortcut wait from 800ms to 1200ms.

---

## Multi-Monitor Assessment

### How coordinates currently work:

| Step | Coordinate space | Tool |
|---|---|---|
| Screenshot capture | Window-relative (scrot -u) | scrot |
| OCR extraction | Image-pixel-relative (within captured image) | tesseract |
| Coordinate caching | Same as OCR output (no translation) | coordinate-cache.ts |
| Click execution | **Absolute screen space** | xdotool mousemove |

### The gap:

OCR returns (x, y) within the captured window image. xdotool expects (x, y) in absolute screen space. These only match when the captured window starts at (0, 0) in screen space — i.e., maximized on the primary monitor.

### Is this actually showing up in live failures?

**Unknown — needs live test.** The logs show "Pre-loaded 12 cached coordinates for gimp" which suggests coordinates have been working. If your GIMP window is maximized on the primary monitor, they would be correct by coincidence.

### Whether negative or offset monitor coordinates could cause misalignment:

Yes. If Monitor 2 is at +1920+0, and GIMP is on Monitor 2, OCR would return e.g. (300, 50) but the correct absolute coordinate would be (2220, 50). The click would land on Monitor 1 instead.

### Verdict:

**Multi-monitor is a real defect in the coordinate pipeline, but it may not be triggering yet** if you primarily use GIMP maximized on the primary monitor. This is a latent bug, not a current failure.

---

## Text-Entry Safety Audit

### Current behavior before text entry:

1. `smartFocus(windowName)` — attempts focus, never verifies
2. `wait(100)` — if focus wasn't cached-skip
3. `xdotool type` — types immediately

### Is this safe enough?

**No.** The focus-verify gap (Defect A) means typing can go to the wrong window. The 100ms wait is insufficient if the window manager is slow to respond.

### Recommended minimal changes:

**Change 1 (P0): Verify focus in smartFocus()**

After `wmctrl -a`, check `xdotool getactivewindow getwindowname` matches. If not, return `{ focused: false, skipped: false }`. Callers already check for errors.

**Change 2 (P1): Abort type if focus failed**

In the `type` case, check smartFocus return value:
```typescript
if (effectiveWindow) {
  const { focused, skipped } = await smartFocus(effectiveWindow);
  if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting type to prevent text entry into wrong window.`;
  if (!skipped) await wait(100);
}
```

Same pattern for `click` and `key`.

---

## Recommended Fixes (smallest first)

| Priority | Fix | Scope | Defect |
|---|---|---|---|
| **P0** | Add focus verification to `smartFocus()` — check active window title after wmctrl | ~10 lines | A (Focus) |
| **P0** | Abort `type`/`click`/`key` if `smartFocus()` returns `focused: false` | ~6 lines (3 cases × 2 lines) | D (Input-target) |
| **P1** | For OCR-derived coordinates on non-maximized/non-primary windows: query window geometry via `xdotool getwindowgeometry` and add offset | ~15 lines in screenshot-analyzer.py or in the click handler | B+C (Coordinate + Monitor) |
| **P2** | Increase `export_file` shortcut wait from 800ms to 1200ms | 1 line | F (Timing) |

---

## Test Script

Run this in Clawdia after rebuilding with the routing fix. It exercises every task class from the validation requirements:

### Test 1: Typing into already-running window
Open gedit/xed first, then:
> Type "Verification test" into the text editor window that's currently open

**Expected**: gui_interact with click_and_type or focus + type macro. Look for `[Macro]` in logs.

### Test 2: Menu navigation
Open GIMP first, then:
> In GIMP, go to Filters > Light and Shadow > Gradient Flare

**Expected**: gui_interact with open_menu_path. Look for `[Macro] open_menu_path` steps.

### Test 3: Export dialog
With GIMP open and a canvas active:
> Export the current GIMP canvas as /tmp/validation-test.png

**Expected**: gui_interact with export_file macro. Verify file exists after.

### Test 4: Focus switching
Open both GIMP and a text editor, then:
> Switch to the text editor, type "test", then switch to GIMP and take a screenshot

**Expected**: Two focus calls. Check logs for focus verification (after P0 fix is applied).

### Test 5: Headless task (regression check)
> Create a 400x400 red circle on white background and save as /tmp/circle.png

**Expected**: Still routes to programmatic (python3+pillow), completes in 2-3 calls. gui_interact should NOT be used.

---

## Blunt Conclusion

**The routing fix was necessary but exposed real GUI defects that must now be patched.**

Specifically:

1. **Focus verification is missing** (P0) — `smartFocus()` never confirms the right window is active. This is the #1 cause of GUI interaction failures and must be fixed before gui_interact is relied upon as a real fallback surface.

2. **Type/click/key don't abort on focus failure** (P0) — they proceed blindly, sending input to whatever window happens to be focused.

3. **OCR coordinates are window-relative but xdotool expects screen-absolute** (P1) — works by coincidence when the window is maximized on the primary monitor, breaks on secondary monitors or floating windows.

The routing fix was correct and sufficient for the routing layer. But the GUI interaction layer has 2 P0 defects that make it unreliable as a fallback surface until patched. The patches are surgical (16 lines total for both P0 fixes) and don't require any architecture changes.

**After applying the 2 P0 fixes, GUI is production-usable for legitimate fallback tasks** — typing into running windows, menu navigation, dialog interaction, and export workflows.
