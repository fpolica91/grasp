# grasp — the post-editor

The review surface for a world where the **agent writes the code** and the **human owns what
it means**. grasp runs the change **for real**, renders the **observed dataflow** (how your data
enters, what happens now, and what happened before — the A→B), and ends in a question —
*"is this what you expected?"* — never a verdict. The human adjudicates behavior they can see
instead of grading code they can't understand.

Read **[`docs/thesis.md`](docs/thesis.md)** before touching anything — it is the anti-drift
north star (paradigm, the three oracles, the moat, the keep/cut line, the graph's design law).

## Layout

```
engine/   the ORGAN — runs, observes, types, classifies, diffs, fuzzes, makes-runnable.
          Carved from dreplay's flow instrument. The one thing the agent CANNOT fake.
          201 tests green (flow canaries FC1–FC8 + the no-verdict conformance moat).
skills/   grasp AS A ZCODE SKILL — `observe-flow/` installs into ZCode and makes its
          agent surface the observed dataflow after a change. This is how grasp ships.
graph/    the SURFACE — the dataflow graph render (single + A→B diff). Used by the
          engine's --html; destined for ZCode's Review pane.
shell/    NOT a shell we build. ZCode IS the shell. Only the telemetry guard for
          running ZCode cleanly lives here.
docs/     thesis.md.
```

## The shape (corrected)

grasp is **not an app**. **ZCode is the shell** (Claude-desktop-grade agent: tasks, chat,
terminal, browser, Review pane, `$skill` system). grasp is the **engine + a skill** you
install into ZCode. The skill makes ZCode's agent, after it changes code, run the engine and
present the observed dataflow ending in "intended?" — the Claude-desktop → post-editor
transformation.

## The line

**Skills orchestrate, code observes.** The agent decides *when/what* to trace; it never drives
the observation itself. If the agent generates the flow, the flow is a guess and the thesis is
dead — so the engine (real execution) is the one thing that can't be an LLM in a trenchcoat.

## Engine gate

```bash
cd engine && make venv && make test    # flow_canaries + tests; toolchain tests self-skip
```

## Reference

- `../harness` — the dreplay codebase, preserved untouched (engine source of truth + the
  retired differ's home).
- `../zcode-re` — the reverse-engineered ZCode 3.2.5 (the chassis; what to keep, what to rip out).
