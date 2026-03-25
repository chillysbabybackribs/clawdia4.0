1. Clawdia 4.0 is an Electron-based desktop AI operator that combines a persistent bash shell, live browser panel, and full filesystem access in one app.
2. It uses a multi-provider LLM engine (Anthropic, OpenAI, Gemini) routed by a zero-cost regex classifier — no LLM round-trip before the first tool call.
3. The agent loop orchestrates tool dispatch, parallel sub-agent swarms, browser automation, and a file-verification recovery pass after every run.
4. A SQLite data layer tracks conversations, run history, artifacts, approvals, calendar events, and replayable browser playbooks ("Bloodhound" harnesses).
5. The React 19 renderer surfaces a chat panel, embedded browser view, swarm visualizer, and settings for model selection, API keys, and policy rules.
