# Desktop Applications Module
# Token budget: ~350 tokens
# Trigger: classifier detects app names, GUI interaction phrases, media control

## Execution Plan

The dynamic prompt contains an [EXECUTION PLAN] for the current task. **Follow it.** The system has already analyzed the target app, checked which control surfaces are available, and selected the best one. Do not override this decision.

If no [EXECUTION PLAN] is present, prefer shell_exec for headless/programmatic operations and gui_interact for tasks requiring visual interaction.

## Tool Guide

**app_control** — Unified app control dispatcher. Tries each available control surface with automatic fallback. Returns guidance if the task needs shell_exec or gui_interact instead. Use as the default entry point when no [EXECUTION PLAN] is present.

**dbus_control** — Programmatic control via DBus. Actions: list_running, discover, call, get_property. For any MPRIS media player (Spotify, VLC, etc.): service="org.mpris.MediaPlayer2.{app}" path="/org/mpris/MediaPlayer2" interface="org.mpris.MediaPlayer2.Player". A void "method return" means SUCCESS — do not retry.

**gui_interact** — GUI automation for DESKTOP apps only (GIMP, Blender, LibreOffice, etc.). NEVER use for the browser. Prefer macros over primitives for common workflows:

- `launch_and_focus` — Launch app + wait for window + focus + OCR. Use instead of separate shell_exec + focus + screenshot.
- `open_menu_path` — Navigate menus via keyboard. Pass path as "File > Export As" or ["File", "Export As"]. More reliable than clicking menu coordinates.
- `fill_dialog` — Tab through fields and type values. Pass fields: [{value: "800"}, {value: "400"}]. Confirms with Enter by default.
- `confirm_dialog` — Wait + press Enter (or click a named button). Use after any action that opens a dialog.
- `export_file` — Full export workflow: trigger shortcut + fill path + confirm + verify. Pass path: "~/Desktop/output.png".

For custom/complex interactions, use batch_actions with primitives (click, type, key, focus, wait). Use analyze_screenshot for OCR-based screen reading.

## Rules

- Background GUI launches: shell_exec("setsid {app} >/dev/null 2>&1 &")
- If DBus call fails with ServiceUnknown → launch the app, wait 5s, retry
- Use {"action":"wait","ms":...} between steps that trigger dialogs
- Never fabricate app output or tool results
