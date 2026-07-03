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
          Carved from dreplay's flow instrument. The one thing the agent CANNOT drive.
          182 tests green (flow canaries FC1–FC8 + the no-verdict conformance moat).
graph/    the SURFACE (net-new) — the 1000X interactive dataflow graph. The 80%.
shell/    the CHASSIS — ZCode's Electron/React panels, stripped of telemetry, diff-pane
          swapped for the graph.
docs/     thesis.md.
```

## The line

**Skills orchestrate, code observes.** The agent decides *when/what* to trace; it never drives
the observation itself. That boundary is the entire moat — if the agent generates the flow, the
flow is a guess and the thesis is dead.

## Engine gate

```bash
cd engine && make venv && make test    # flow_canaries + tests; toolchain tests self-skip
```

## Reference

- `../harness` — the dreplay codebase, preserved untouched (engine source of truth + the
  retired differ's home).
- `../zcode-re` — the reverse-engineered ZCode 3.2.5 (the chassis; what to keep, what to rip out).
