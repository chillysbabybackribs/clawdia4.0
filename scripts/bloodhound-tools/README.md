# openclaw-local — Local Control Plane for OpenClaw

> **Run OpenClaw locally with zero friction. Add enforceable security boundaries when you decide.**

![build](https://img.shields.io/badge/build-passing-brightgreen)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)
![license](https://img.shields.io/badge/license-open--core-lightgrey)

**openclaw-local** is a local installer and control plane for OpenClaw. The free version removes setup friction. The paid unlock adds enforced security boundaries. Same OpenClaw. Same power. Optional blast-radius control.

---

## TL;DR

- **Free:** Expedited installer + local runtime management — OpenClaw unchanged
- **Paid unlock:** Enables security enforcement modes (filesystem boundaries, write gating)
- **RAW is not a tier** — it's simply OpenClaw running without added security boundaries

---

## What This Is

A **local-first desktop control plane** that installs, runs, and manages OpenClaw on your machine.

- Installation & runtime orchestration
- (Optionally) enforcing *where* actions are allowed to apply

It does **not** change how OpenClaw thinks, plans, or acts.

## What This Is NOT

- Not a hosted service or cloud agent
- Not a sandbox or fork of OpenClaw
- Not "safe by default" — if you want a neutered agent, this isn't it

---

## Free vs Paid

| | Free | Paid Unlock |
|---|------|-------------|
| **What you get** | Expedited installer + control plane | Enables security enforcement |
| **OpenClaw behavior** | Unchanged (identical to upstream) | Unchanged |
| **Security boundaries** | None | Enforced at runtime |
| **Capability restrictions** | None | None |

**Free** = OpenClaw, easier to install and operate.
**Paid** = Same thing, plus enforcement when you want it.

---

## Quick Decision Tree

- **Want OpenClaw running locally?** → openclaw-local (free)
- **Care where files/credentials can be written?** → consider paid enforcement
- **Run unattended or overnight?** → consider paid enforcement
- **Just want it working fast?** → free is enough

---

## Comparison

| Feature | OpenClaw (Upstream) | openclaw-local | + Security Enforcement |
|---------|---------------------|----------------|------------------------|
| Runs locally | ✅ | ✅ | ✅ |
| Full autonomy | ✅ | ✅ | ✅ |
| OS-level commands | ✅ | ✅ | ✅ |
| File system access | Unrestricted | Unrestricted | Boundary-enforced |
| Install friction | High | Low | Low |
| Runtime UI | ❌ | ✅ | ✅ |
| Enforced boundaries | ❌ | ❌ | ✅ |

---

## Security Enforcement

When the paid unlock is enabled, openclaw-local can enforce:

- **RAW_SECURED** — full behavior, enforced filesystem boundaries
- **RAW_RESTRICTED** — allow-listed paths only
- **RESTRICT_ME** — read-only by default, time-bound write approval

These modes control **where** actions apply — not **what** OpenClaw can do.

---

## Pricing

One-time purchase. No subscription.

| | |
|---|---|
| Free | Always free — installer + runtime management |
| Paid | ~$49–$99 (indicative, may evolve) |

You're paying for **enforcement**, not capability.

No accounts. No telemetry. No usage tracking.

---

## Install

**Status:** Active development

- Developer builds currently unsigned
- Signed installers planned (Windows & Linux first)

---

## Disclaimer

OpenClaw is powerful software. openclaw-local gives you the **option** to enforce boundaries — it doesn't make it "safe" by default. Use responsibly.
