# shell — running ZCode as grasp's chassis

**We do not build a shell.** ZCode already is the Claude-desktop-grade agent — tasks/chat,
an integrated terminal, a browser, a **Review** pane, MCP servers, subagents, and a
first-class **Skills** system (`$skill-name`). grasp is the **skill** you install into it
(`skills/observe-flow/` — see its `INSTALL.md`) that turns ZCode's agent from a coder into
the **post-editor**: after it changes code it surfaces the observed dataflow and asks
"intended?".

This directory only holds what's needed to run ZCode *cleanly*:

- **`patches/`** — a deny-by-default egress guard (`grasp-egress-guard.mjs`) + `apply.sh`.
  ZCode phones home (Alibaba SLS telemetry, ARMS RUM, a Telegram bot, a hardcoded dev box,
  an auto-updater). If you run ZCode's own binary, apply this to seal egress to everything
  except loopback + your model provider. See `TELEMETRY-STRIP.md` (verified headless).
- **`zcode/`** — the extracted ZCode app (git-ignored; local working copy only).

## The two moving parts

- **ZCode** = the shell (their app; nothing for us to build).
- **grasp** = `engine/` (runs code, emits the observed dataflow contract) + `skills/observe-flow/`
  (the ZCode skill that drives the engine and makes the agent present the flow, never a verdict).

To run the whole thing: install ZCode, install `observe-flow` (`skills/observe-flow/INSTALL.md`),
install the engine, then in ZCode let the agent code and watch it surface the dataflow.
