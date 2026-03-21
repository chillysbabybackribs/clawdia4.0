# Clawdia

**I'm an autonomous AI agent that lives on your desktop and controls your entire computer. No API integrations. No cloud services. No subscriptions. Just your OS, your browser, your apps — and me.**

I'm built as an Electron application. You bring an API key from Anthropic, Google, or OpenAI, and I handle everything else. I browse the web in your authenticated sessions. I run your terminal. I control your desktop applications. I read, write, and organize your files. I remember what you've told me and what I've learned. I get smarter and cheaper every time you use me.

There is no other AI agent that works like this.

---

## How I work

When you type a message, I don't just send it to an LLM and hope for the best. Before any AI model sees your words, my classifier — pure regex pattern matching, zero cost, zero latency — analyzes what you're asking for and makes three decisions in milliseconds:

1. **Which tools do I need?** If you're asking me to post on Reddit, I load my browser tools. If you're asking me to refactor code, I load filesystem and shell tools. If you need both, I load both.

2. **Which prompt modules matter?** I inject only the context that's relevant — coding guidelines for code tasks, browser navigation patterns for web tasks, desktop control protocols for app tasks. I don't waste tokens on instructions I won't use.

3. **Which model tier fits?** A simple greeting gets the cheapest model. A complex multi-step research task gets the most capable one. You pay for what the task actually requires, not a flat rate for every message.

Then my agent loop runs — up to 50 reasoning iterations per task, with parallel tool dispatch, live streaming to the UI, and approval gates before anything destructive. I can pause, resume, or cancel at any point. If a file operation doesn't produce the expected result, I run a recovery pass automatically.

---

## The browser — this is the big one

Here's what makes me fundamentally different from every other AI agent on the market.

Every other agent that wants to interact with a web service needs a dedicated API integration. Want to post to LinkedIn? You need LinkedIn's API, OAuth credentials, developer approval, rate limits. Want to read your Gmail? Google Cloud project, OAuth consent screen, API quotas. Want to control your bank account? Forget it — there is no API for that.

**I don't use any APIs. Not a single one. Zero integrations.**

Instead, I have a live Chromium browser panel embedded directly in my UI. And here's the critical detail: **it shares your real browser session.** When you log into Reddit in my browser panel, or GitHub, or your bank, or YouTube, or Gmail — those sessions persist. Your cookies are there. Your authentication is there. I am you, as far as every website is concerned.

### What happens when you say "post this to Reddit"

Let me walk you through exactly what happens, step by step:

1. **Classification.** My classifier sees the word "Reddit" and flags this as a browser task. I load my browser tool group — `browser_navigate`, `browser_click`, `browser_fill_field`, `browser_detect_form`, `browser_extract`, and others.

2. **Session check.** My dynamic prompt already knows which sites you're authenticated on. Reddit is in the list? I know I can navigate there directly without hitting a login wall.

3. **Navigation.** I call `browser_navigate` to go to the subreddit. This uses Electron's BrowserView — a full Chromium instance — and my `persist:browser` session partition, which retains all your cookies across restarts. The page loads, and I get back the full visible text content and all interactive elements with their CSS selectors.

4. **Form detection.** I call `browser_detect_form` to map every field on the page — title, body, flair selector, whatever Reddit's current UI exposes. I get back stable CSS selectors for each field, their types, their placeholders, and the submit button.

5. **Native input.** Here's where it gets technical. I don't inject JavaScript to set `element.value`. That doesn't work on modern React/Vue/Angular apps because they manage state internally — setting the DOM value doesn't update the framework's state, so the form thinks the field is empty. Instead, I use **Chromium's native input pipeline**: `webContents.sendInputEvent()`. I dispatch real `mouseDown`, `mouseUp`, `keyDown`, `keyUp`, and `char` events through the same pathway a physical keyboard and mouse use. React sees real input events. Angular sees real input events. Web Components, Shadow DOM, contenteditable divs — they all work, because at the input layer, I am indistinguishable from a human.

6. **Submission.** I click the submit button with a real native click event. Then I wait for navigation or DOM settlement and read the result page to confirm success — I look for confirmation text, a URL change, or a success indicator.

7. **Harness registration.** If this is the first time I've filled this form, I save a **site harness** — the exact CSS selectors for every field, the submit button, the success verification pattern. Next time you ask me to post on Reddit, I skip steps 3-6 entirely and replay the harness in under 5 seconds, with zero LLM calls, zero token cost.

### Every platform. No exceptions.

Because I operate through a real browser with your real sessions, I can control:

- **Social media** — Reddit, Twitter/X, LinkedIn, Facebook, Instagram, TikTok, Mastodon. Post, comment, like, message, manage settings.
- **Email** — Gmail, Yahoo Mail, Outlook, Protonmail. Read, compose, reply, search, organize.
- **Banking** — Chase, Bank of America, your credit union, Venmo, PayPal, Robinhood, Alpaca. Check balances, review transactions, initiate transfers.
- **Video platforms** — YouTube, Twitch, Vimeo. Watch, search, manage playlists, check analytics, manage channel settings.
- **Development** — GitHub, GitLab, Bitbucket. Review PRs, merge, manage issues, check CI/CD, navigate repos.
- **Productivity** — Google Docs, Notion, Trello, Jira, Confluence, Slack, Discord.
- **Shopping** — Amazon, eBay, Walmart, Newegg. Research, compare, track orders.
- **Anything else you can log into in a browser.**

I don't need the platform's permission. I don't need their API. I don't need a developer account. If you can see it in a browser, I can operate it.

### Bot detection? Not an issue.

Bot detection systems look for telltale signs: headless browser flags, automated input patterns, JavaScript injection, missing browser fingerprints. I don't trigger any of them because:

- I run in a **real Chromium instance** with full GPU rendering, WebGL, canvas fingerprinting — everything a normal browser has
- My input goes through **native Chromium event dispatch**, not JavaScript injection
- I use a **standard Chrome user agent** string
- I have **real cookies and session state** from a real human login
- I don't run headless — the browser panel is visible in my UI, and you can watch everything I do in real time

---

## The Bloodhound System — I learn everything I do

The first time I complete any browser workflow, I figure it out step by step — navigating, reading the page, finding the right elements, clicking, typing, verifying. This costs tokens because the LLM is reasoning through every step.

But I never do the same work twice.

When a workflow succeeds, I save the entire execution path as a **playbook** — the exact sequence of URLs, clicks, form fills, and verifications that worked. The next time you ask for the same thing, I replay the playbook directly. No exploration, no LLM reasoning, no guessing. A task that cost 4,000 tokens the first time costs 200 the second time.

For forms specifically, I create **site harnesses** — compiled, deterministic form-filling sequences stored in SQLite. A harness contains the exact CSS selector for every field, the field type (native input, textarea, contenteditable, shadow DOM), the submit button, and success/error verification selectors. Harnesses execute in 2-5 seconds with zero AI token cost.

The more you use me, the faster and cheaper I get. My Bloodhound system turns your most repeated workflows into near-zero-cost operations.

---

## Desktop application control

I don't just live in the browser. I control your entire desktop.

For supported applications — **GIMP, Blender, Inkscape, LibreOffice, OBS, Audacity, Kdenlive, ffmpeg, ImageMagick** — I build dedicated CLI harnesses that let me control them through structured terminal commands. No GUI scraping. No fragile click coordinates. Deterministic, repeatable control.

For everything else, I work through a priority chain of control surfaces:

1. **Native CLI** — If the app has a command-line interface, I use it directly
2. **CLI-Anything** — My system for wrapping any desktop app in a custom CLI harness
3. **DBus** — I call system service methods directly. Spotify playback, PulseAudio volume, GNOME desktop settings, any DBus-exposing application
4. **AT-SPI Accessibility Tree** — I read the full UI structure of any window through Linux's accessibility framework and interact with elements programmatically
5. **Screenshot Analysis** — Last resort. I take a screenshot, analyze it with vision, identify elements, and act

I always use the most structured method available. GUI screenshot analysis only happens when nothing more reliable exists.

---

## Agent swarm — parallel sub-agents

For complex tasks, I don't work alone. I spawn parallel sub-agents, each with:

- Its own isolated browser tab (so they don't clobber each other's navigation)
- A defined role — scout, analyst, builder, writer, reviewer, data, devops, security
- A token budget enforced per role
- Clean history (no parent conversation bleed)
- Its own AbortController tied to the parent's signal

They work simultaneously and report back. I synthesize the results. A task that would take 15 sequential steps runs as 5 parallel branches. You watch every agent's status live in the UI.

For the most complex tasks, I compile a full **execution graph** — decomposing the work into a DAG of parallel worker nodes, each with a defined executor kind, an output contract, and verification checks. Results are validated against their contracts, failed nodes retry, and everything merges into a unified response.

---

## Filesystem — I understand your files

I don't just read and write individual files. I understand your filesystem as a whole:

- **Phrase search** — Find which file contains a specific sentence or quote, across text files and PDFs, ranked by confidence
- **Directory intelligence** — Summarize any folder with file counts, dominant types, largest files, and recent activity — without dumping a raw tree
- **Duplicate detection** — Scan for exact duplicate files by content hash, show reclaimable space, without deleting anything until you approve
- **Reorganization planning** — Propose a full folder restructuring with explicit source → destination moves, preview it, and apply it only after your review
- **Surgical editing** — Edit files by exact string replacement, verify the build, and read back to confirm

---

## Memory — I remember you

I maintain a searchable memory store in SQLite with full-text search — facts, preferences, context, notes about your projects. Before every response, I automatically retrieve relevant memories without being asked.

I also search past conversations using FTS5, surfacing prior context when it's relevant. If you told me three weeks ago that you prefer tabs over spaces, I know that today.

The longer you use me, the more useful I become.

---

## Calendar

I have a full calendar system backed by SQLite. Today's events are injected into my context on every single message — I always know your schedule. I can add, update, query, and manage events through natural conversation, and there's a CLI for scripting and external access.

---

## Terminal — full shell access

I have a persistent bash shell session with your user's full environment — PATH, aliases, permissions. The shell retains its working directory between calls. I run commands, manage processes, install packages, work with git, execute scripts, and react to output. Same access you have in a terminal, with the reasoning to use it well.

---

## Supported AI providers

I route to the right model automatically — lightweight models for fast simple tasks, capable models for complex reasoning.

| Provider | Tiers |
|----------|-------|
| **Anthropic Claude** | Haiku · Sonnet · Opus |
| **Google Gemini** | Flash · Pro · Ultra |
| **OpenAI** | GPT-4o mini · GPT-4o · o1 |

Switch providers per conversation. All three share the same tool interface. You only pay for what each task actually requires.

---

## Your data stays on your machine

Everything is local. No telemetry. No cloud sync. No accounts.

- **Conversations, memory, playbooks, harnesses, calendar** → SQLite at `~/.config/clawdia/data.sqlite`
- **Settings and API key** → `~/.config/clawdia/config.json`

Your API key is sent only to the LLM provider you configure. Nothing else leaves your machine. I run with full system access because that's the entire point — I'm your operator, not a sandboxed chatbot.

---

## Install

```bash
git clone https://github.com/chillysbabybackribs/clawdia4.0.git
cd clawdia4.0
./setup.sh
npm run dev
```

The setup script checks prerequisites, installs system dependencies, compiles the project, and detects GPU configuration. On first launch, a welcome screen walks you through connecting your LLM provider.

**Hybrid GPU / NVIDIA systems:**
```bash
npm run dev:nogpu
```

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New chat |
| `Ctrl+L` | Clear / new chat |
| `Ctrl+B` | Toggle browser panel |
| `Ctrl+H` | Conversation history |
| `Ctrl+,` | Settings |
| `Escape` | Back to chat |

---

## Development

```bash
npm run dev          # TypeScript + Vite + Electron in watch mode
npm run build        # Production build
npm start            # Run production build
npm test             # Vitest unit tests
npm run package      # Build AppImage (Linux)
```

---

## License

MIT
