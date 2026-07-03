"""End-to-end --diff test for flow_cli (spec §9.3).

Builds a two-commit git repo: OLD binds ``owner = None``, NEW binds
``owner = 42``. Runs the flow CLI in ``--diff`` mode (OLD checked out into a
worktree vs NEW in the repo working tree) and asserts the rendered diff surfaces
the change — and that no verdict word leaks into the output.
"""
from __future__ import annotations

import os
import subprocess
import tempfile

from dreplay import flow_cli


# Matches the verdict lists in dreplay/flow_diff.py / flow_render.py.
_VERDICT_WORDS = (
    "bug", "risk", "vulnerab", "exceed", "broken", "wrong", "fail",
    "bad", "danger", "insecure", "leak", "exploit", "crash", "error",
)


def _git(repo: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True, text=True
    ).stdout


def _make_owner_repo() -> str:
    """A two-commit repo: OLD binds owner=None, NEW binds owner=42."""
    repo = tempfile.mkdtemp()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@t")
    _git(repo, "config", "user.name", "t")

    pkg = os.path.join(repo, "orgapp")
    os.makedirs(pkg)
    with open(os.path.join(pkg, "__init__.py"), "w"):
        pass

    # OLD behavior: owner bound to None.
    with open(os.path.join(pkg, "service.py"), "w") as fh:
        fh.write(
            "def create_org(name):\n"
            "    org = {'name': name, 'owner': None, 'status': 'active'}\n"
            "    _save(org)\n"
            "    return org\n"
            "\n"
            "def _save(record):\n"
            "    record['saved'] = True\n"
        )
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "old: owner=None")

    # NEW behavior: owner bound to 42.
    with open(os.path.join(pkg, "service.py"), "w") as fh:
        fh.write(
            "def create_org(name):\n"
            "    org = {'name': name, 'owner': 42, 'status': 'active'}\n"
            "    _save(org)\n"
            "    return org\n"
            "\n"
            "def _save(record):\n"
            "    record['saved'] = True\n"
        )
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "new: owner=42")
    return repo


def _has_word(haystack: str, needle: str) -> bool:
    n = len(needle)
    idx = 0
    while True:
        idx = haystack.find(needle, idx)
        if idx == -1:
            return False
        before = haystack[idx - 1] if idx > 0 else " "
        after = haystack[idx + n] if idx + n < len(haystack) else " "
        if not (before.isalnum() or before == "_") and not (
            after.isalnum() or after == "_"
        ):
            return True
        idx += 1


def test_flow_cli_diff_surfaces_owner_change(capsys) -> None:
    repo = _make_owner_repo()
    rc = flow_cli.main(
        [
            "--entrypoint", "orgapp.service.create_org",
            "--input", '{"name": "acme"}',
            "--repo", repo,
            "--diff",
            "--old", "HEAD~1",
            "--plain",  # force the plain renderer (no TTY in the test runner)
        ]
    )

    out = capsys.readouterr().out
    assert rc == 1, (
        f"--diff must exit 1 when a change surfaces (not a verdict): rc={rc}\n{out}"
    )

    # Header: entrypoint, old->new refs, payload, classifier mode.
    assert "flow-diff:" in out
    assert "orgapp.service.create_org" in out
    assert "old:" in out and "new:" in out and "->" in out
    assert "payload:" in out
    assert "classifier=" in out

    # The change: owner None -> 42 must be surfaced as a node change with the
    # operand delta (status icon '~' for changed).
    assert "owner" in out
    assert "None" in out
    assert "42" in out
    assert "~" in out  # the 'changed' status icon
    assert "->" in out  # the old -> new delta arrow

    # The neutral question close, never a verdict word.
    assert "intended?" in out
    low = out.lower()
    for w in _VERDICT_WORDS:
        assert not _has_word(low, w), f"--diff output leaked verdict word {w!r}:\n{out}"

    # No leftover worktree.
    worktrees = _git(repo, "worktree", "list").splitlines()
    assert len(worktrees) == 1, f"--diff left a worktree behind: {worktrees}"


def test_flow_cli_diff_requires_old_ref(capsys) -> None:
    repo = _make_owner_repo()
    rc = flow_cli.main(
        [
            "--entrypoint", "orgapp.service.create_org",
            "--input", '{"name": "acme"}',
            "--repo", repo,
            "--diff",
            # no --old
            "--plain",
        ]
    )
    assert rc == 2, f"--diff without --old must be a usage error (rc=2): rc={rc}"
    err = capsys.readouterr().err
    assert "--old" in err
