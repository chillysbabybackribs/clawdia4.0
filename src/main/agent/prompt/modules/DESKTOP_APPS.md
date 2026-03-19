# Desktop Applications Module
# Token budget: ~500 tokens
# Trigger: classifier detects app names, GUI interaction phrases, media control

## Execution Plan

The dynamic prompt contains an [EXECUTION PLAN] for the current task. **Follow it.** The system has already analyzed the target app, checked which control surfaces are available, and selected the best one. Do not override this decision.

If no [EXECUTION PLAN] is present, choose the approach yourself using this priority:

1. **Programmatic** (shell_exec with Python/ImageMagick/ffmpeg) — for creating, converting, or batch-processing images, documents, audio, video. No GUI needed.
2. **DBus** (dbus_control) — for running apps with MPRIS/DBus interfaces. Media control (play, pause, next, volume) should always try DBus first.
3. **CLI** (app_control or shell_exec) — for apps with native CLI or CLI-Anything harnesses. Use headless/batch modes.
4. **GUI** (gui_interact) — LAST RESORT. Only when the task requires visual interaction that no other surface can provide (e.g., using specific GUI tools, brushes, layers).

## Tool Guide

**app_control** — Unified app control dispatcher. Automatically tries each available surface (DBus → CLI-Anything → native CLI) with fallback. Returns actionable guidance if the task needs shell_exec (programmatic) or gui_interact (visual) instead. Use as the default entry point for app interaction.

**dbus_control** — Programmatic control via DBus. Actions: list_running, discover, call, get_property. For any MPRIS media player (Spotify, VLC, etc.): service="org.mpris.MediaPlayer2.{app}" path="/org/mpris/MediaPlayer2" interface="org.mpris.MediaPlayer2.Player". A void "method return" means SUCCESS — do not retry.

**gui_interact** — GUI automation. Use batch_actions with a top-level window parameter for multi-step sequences. Use keyboard shortcuts from the shortcut reference when available. Use analyze_screenshot to read screen state via OCR (~400 tokens) instead of raw screenshots (~50K tokens). Use verify_file_exists after exports instead of screenshots.

## Rules

- Background GUI launches: shell_exec("setsid {app} >/dev/null 2>&1 &")
- If DBus call fails with ServiceUnknown → launch the app, wait 5s, retry
- Use {"action":"wait","ms":...} between steps that trigger dialogs
- Never fabricate app output or tool results
