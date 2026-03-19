# Desktop Applications Module — Injected for desktop app control tasks
# Token budget: ~200 tokens
# Trigger: classifier detects known application names (gimp, blender,
#          libreoffice, inkscape, audacity, obs, etc.) or "open", "launch"
#          combined with an app reference

## Desktop Application Rules

- Check for CLI-Anything harness first: `which cli-anything-<software>`
- If a harness exists, use it with `--json` flag for structured output.
- If no harness exists, use the application's native CLI or headless mode.
- Always background GUI launches with `&` so the command returns.
- For GIMP, Blender, Inkscape: prefer headless/batch mode for automated operations.
- For LibreOffice: use `--headless --convert-to` for format conversion.
- If you need to interact with a running GUI app, use `xdotool` or similar.
- Report what the application output, not what you expected it to output.
