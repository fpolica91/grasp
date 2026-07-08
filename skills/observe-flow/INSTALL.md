# Installing observe-flow into ZCode

`observe-flow` turns ZCode's agent from a coder into the **post-editor**: after it changes
code, it surfaces the observed dataflow and asks "intended?" instead of asserting it works.

## 1. Install the skill

ZCode discovers skills under (highest priority first):

- `<project>/.zcode/skills/<name>/` · `<project>/.agents/skills/<name>/`
- `~/.zcode/skills/<name>/` · `~/.agents/skills/<name>/`

Copy this skill into one of them — user-wide is simplest:

```bash
mkdir -p ~/.agents/skills
cp -r observe-flow ~/.agents/skills/observe-flow
```

Or, from ZCode: **Settings → Skills → Install** (the skill-installer accepts a GitHub repo
path — point it at `fpolica91/grasp`, subdir `skills/observe-flow`).

It shows up under **Settings → Skills** and in the `$` menu as `$observe-flow`; enable it.

## 2. Install the engine (once)

The skill shells the grasp engine. Make it importable one of two ways:

```bash
# a) pip install from the repo
pip install "git+https://github.com/fpolica91/grasp.git#subdirectory=engine"

# b) or point at a checkout's venv
git clone https://github.com/fpolica91/grasp.git
cd grasp/engine && make venv
export GRASP_ENGINE=$PWD          # the skill's scripts/observe.sh finds .venv here
```

Verify: `scripts/observe.sh observe --repo grasp/engine \
  --entrypoint flow_canaries.scenarios.create_organization --input '{"name":"Acme"}'`
should print JSON whose `graph.questions` includes `write binds owner = NULL — intended?`.

## 3. Use it

In ZCode, either let it trigger automatically after a code change, or invoke `$observe-flow`
explicitly. It runs the entrypoint for real and presents the observed dataflow, ending in a
question you adjudicate.

**grasp runs code FOR REAL — never point it at untrusted code.**
