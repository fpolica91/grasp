"""Git worktree management for checking out the old branch side-by-side.

``run_differential_replay`` checks out ``old_ref`` into a worktree so the same
dotted module path resolves to old-code, while the new branch stays checked out
in the working tree. Each worktree ideally gets its own venv if dependencies
differ between branches (F4); v1 documents dep-skew as out of scope otherwise —
a branch that fails to import is a refuse-state boundary, not a divergence.
"""
from __future__ import annotations

import os
import subprocess
import tempfile


def add(repo_path: str, ref: str, dest: str | None = None) -> str:
    """``git worktree add --detach <dest> <ref>``. Returns dest."""
    dest = dest or tempfile.mkdtemp(prefix="dreplay-wt-")
    subprocess.run(
        ["git", "-C", repo_path, "worktree", "add", "--detach", dest, ref],
        check=True,
        capture_output=True,
        text=True,
    )
    return dest


def remove(dest: str, repo_path: str | None = None) -> None:
    cmd = ["git"]
    if repo_path:
        cmd += ["-C", repo_path]
    cmd += ["worktree", "remove", "--force", dest]
    subprocess.run(cmd, check=False, capture_output=True, text=True)


def list_worktrees(repo_path: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", repo_path, "worktree", "list", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [line.split(" ", 1)[1] for line in out.splitlines() if line.startswith("worktree ")]
