# Reading the grasp graph contract

`scripts/observe.sh observe|diff` prints a JSON envelope. How to read it — and how to
present it honestly to the user.

## The envelope

- `ok` — the skill ran (vs a usage error / refusal). `false` → show `error`, don't guess.
- `observed` — a real execution was captured. `false` → grasp could not run the code
  (a config/import error, in `error`); this is NOT the same as "no problem".
- `raised` — the observed run raised. A raise is a **fact** (an observed `thrown-error`
  node), not a failure of the skill — surface it as what happened.

## The graph (`graph`, or `graph_diff` for a diff)

- `nodes[]` — each has `kind`, `label`, `business_meaningful`, `presence`, `operands[]`.
  Present only the business-meaningful nodes by default; say "N plumbing steps collapsed".
- `operands[].provenance` — **the honesty axis, always show it**:
  - `observed` — measured this run (a fact).
  - `declared` — read from the source (a fact).
  - `unknown` — **"you supply"**: a blank the human fills, NEVER a value you invent.
- `nodes[].presence` — `observed`, or `ghosted` when grasp could not see inside a step
  (the **coverage boundary**). Say so — never silently drop it.
- `questions[]` — neutral, ending in "— intended?". This is the terminal state you end on.

## For a diff (`graph_diff`)

- `changed_count`, `empty` — `empty:true` means no structural change surfaced for THIS
  input; present the `honest_message`, never "no change / safe".
- `nodes[].status` — `added` / `removed` / `changed` / `unchanged`. A `removed` node is
  ghosted (no longer runs). `changed` nodes carry `deltas[]` as `field: old → new`.
- End on "the dataflow changed from A to B — is this what you expected?".

## What you must never do

Turn any of this into a verdict. No "works", "fixed", "safe", "bug", "risk". Every value
is measured or "you supply". You surface; the human judges.
