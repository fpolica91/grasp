---
name: observe-flow
description: >-
  After you change code, SHOW the human what the change actually does by running it
  for real and surfacing the observed dataflow — the values it binds, the paths it
  takes — as a graph that ends in a neutral question. Use this instead of asserting a
  change "works": observe the behavior, present it, let the human adjudicate. Triggers
  whenever you have edited a code path the user will review, or the user asks "what did
  that change do", "show me the flow", "did this break anything", or wants to see the
  effect of a diff rather than read it.
---

# observe-flow — surface what the change does, never judge it

You (the agent) write code by reading and predicting — you are a guess-machine. This
skill is the anti-guess: it **runs the code for real** and reports **measured facts**
about what happened to the business objects. Your job is to *drive* it and *present*
what it surfaces. It is **not** your job — or this tool's — to conclude the change is
correct, safe, or a bug. The human owns what the code should mean; you hand them the
observed behavior and the open question.

## The three capabilities

Invoke over Bash from the engine venv; each prints the graph contract as JSON on stdout.

```bash
# 1. OBSERVE — run one input, get the observed dataflow graph
python -m dreplay.skill observe --repo <path> --entrypoint <module.func> --input '{"name":"x"}'

# 2. DIFF — observe OLD vs NEW for the SAME input; get both graphs + the A→B delta
python -m dreplay.skill diff --repo <path> --entrypoint <module.func> --old HEAD~1 --input '{"name":"x"}'

# 3. FUZZ — vary the input across a schema; get which operands varied (edge cases)
python -m dreplay.skill fuzz --repo <path> --entrypoint <module.func> --schema schema.json --variants 16
```

Entrypoint formats: `module.func` (py/js/ts) · `file.go:Func` (go) · `file.cpp:func`
(c++) · `Class.method` (java) · `Namespace.Class.Method` (c#). Language auto-detects
from the repo; the graph contract is identical across all of them.

## How to read the result (the contract)

- `graph.nodes[].operands[].provenance` — `observed` (measured this run), `declared`
  (read from source), or `unknown` (**you supply** — a blank, never a fact).
- `graph.nodes[].presence` — `observed`, or `ghosted` when the tool could not see
  inside (the **coverage boundary** — surface it, don't hide it).
- `graph.questions[]` — neutral, ending in "— intended?". This is the terminal state.
- `observed` / `raised` — whether a real run was captured, and whether it raised (a
  raise is a **fact**, not a failure). `error` is set only when it could not observe.
- `diff.changed` / `fuzz.varied` — something surfaced **for review**, NOT a verdict.

## The rule (non-negotiable)

Present the observed dataflow and end with the tool's question. Say **"the dataflow
changed from A to B — is this what you expected?"** Do **not** say it works, it's
fixed, it's safe, it's a bug, or it's a risk. Every value you show is measured or
labelled "you supply" — never inferred. If a capability returns `ok: false`, report
the honest reason (a refusal or config error); do not paper over it with a guess.

Runs code FOR REAL — never point it at untrusted code. `fuzz` is walled by default.
