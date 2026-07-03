---
name: observe-flow
description: >-
  Show what a code change actually DOES by running it for real and surfacing the
  observed dataflow — the values it binds, the paths it takes — as a compact flow that
  ends in a neutral question, never a verdict. Use this immediately after you edit,
  write, or refactor any code the user will rely on, and whenever the user asks "what
  did that change do", "show me the flow/dataflow", "what happens now vs before", "did
  this change behavior", "is this what it does", or wants to understand the effect of a
  diff instead of reading it. Prefer this over asserting a change "works", "is fixed",
  or "looks correct" — observe the behavior, present it, let the human decide.
---

# observe-flow — surface what a change does, never judge it

You write code by reading and predicting — you are a guess-machine. This skill is the
anti-guess: it **runs the code for real** and reports **measured facts** about what
happened to the business objects. Your job is to *drive* it and *present* what it
surfaces. It is not your job — or this tool's — to conclude the change is correct, safe,
a bug, or a risk. The human owns what the code should mean. You hand them the observed
dataflow and the open question; they adjudicate.

## When to fire

Right after you change a code path the user will review, run `observe` on the entrypoint
you touched with a representative input, and show the result. If there is an old version
worth comparing (you just modified an existing function, or the user asks "vs before"),
run `diff` against the prior git ref instead — that is the A→B change view.

## How to run it

`scripts/observe.sh` wraps the grasp engine and prints the graph contract as JSON.
(One-time setup + engine location are in `INSTALL.md`.)

```bash
# OBSERVE — run one input, get the observed dataflow
scripts/observe.sh observe --repo <path> --entrypoint <module.func> --input '{"name":"x"}'

# DIFF — old git ref vs the working tree, same input → the A→B change view
scripts/observe.sh diff --repo <path> --entrypoint <module.func> --old HEAD~1 --input '{"name":"x"}'
```

Entrypoint formats: `module.func` (py/js/ts) · `file.go:Func` (go) · `file.cpp:func`
(c++) · `Class.method` (java) · `Namespace.Class.Method` (c#). Language auto-detects.

## How to present the result

Read the JSON and render it to the user as a short, legible dataflow — one line per
business-meaningful node, the observed operands, and the terminal question. Details of
the contract (provenance, ghosted coverage boundary, questions) are in
`references/reading-the-graph.md`. The shape you present:

```
observed flow: <entrypoint>   (mode instant · classifier <mode>)
  ▶ input        <label>       name='x' [observed]
  ▶ db_write     save          owner=None [observed]
  … <n> plumbing step(s) collapsed
  ▶ return       <label>       …

— the write binds owner = NULL. Is that intended?
```

For a `diff`, present the changed operands as `old → new` and ask "the dataflow changed
from A to B — is this what you expected?".

## The rule (non-negotiable)

Present the observed dataflow and end with the tool's neutral question. Never say it
works, is fixed, safe, a bug, or a risk. Every value you show is measured or labelled
"you supply" — never inferred. If a run returns `ok:false` or `observed:false`, report
the honest reason (a refusal or a config error); do not paper it over with a guess.
`changed`/`varied` mean something surfaced **for review**, not a verdict.

grasp runs code FOR REAL — never point it at untrusted code.
