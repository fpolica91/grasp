#!/usr/bin/env python3
"""Build the dreplay flow-tracing -javaagent JAR.

Compiles the Java sources under ``java_agent/src/`` against a shaded ASM, then
packages them (plus the shaded ASM classes) into a single self-contained JAR whose
manifest declares the ``Premain-Class``. The result is cached at
``java_agent/dist/dreplay-agent.jar`` so we don't rebuild every run.

Requirements: ``javac`` and ``jar`` on PATH (OpenJDK 8+). The Python adapter
``java_flow.py`` calls :func:`ensure_agent` before launching the target, and falls
back to an honest error if the JAR can't be built.

ASM (org.ow2:asm) is downloaded once from Maven Central into ``java_agent/lib/``
and its classes are merged into the agent JAR (shading) so the target program's
classpath never needs ASM — and so there's no version conflict with a target that
might itself depend on a different ASM.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
LIB = os.path.join(HERE, "lib")
DIST = os.path.join(HERE, "dist")
AGENT_JAR = os.path.join(DIST, "dreplay-agent.jar")

ASM_VERSION = "9.7"
ASM_BASE = f"https://repo1.maven.org/maven2/org/ow2/asm"
ASM_JARS = (
    ("asm", f"{ASM_BASE}/asm/{ASM_VERSION}/asm-{ASM_VERSION}.jar"),
    ("asm-tree", f"{ASM_BASE}/asm-tree/{ASM_VERSION}/asm-tree-{ASM_VERSION}.jar"),
    ("asm-commons", f"{ASM_BASE}/asm-commons/{ASM_VERSION}/asm-commons-{ASM_VERSION}.jar"),
    ("asm-analysis", f"{ASM_BASE}/asm-analysis/{ASM_VERSION}/asm-analysis-{ASM_VERSION}.jar"),
)


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def have_jdk() -> bool:
    return shutil.which("javac") is not None and shutil.which("jar") is not None


def _download_asm() -> list[str]:
    """Download the ASM jars into lib/ (cached). Returns their paths."""
    os.makedirs(LIB, exist_ok=True)
    paths: list[str] = []
    for name, url in ASM_JARS:
        dest = os.path.join(LIB, f"{name}-{ASM_VERSION}.jar")
        if not os.path.isfile(dest):
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"could not download {name} from {url}: {exc}") from exc
        paths.append(dest)
    return paths


def _sources_signature() -> str:
    """A hash of all Java sources + this script → invalidates the cache on change."""
    h = hashlib.sha256()
    for root, _dirs, files in os.walk(SRC):
        for f in sorted(files):
            if f.endswith(".java"):
                p = os.path.join(root, f)
                h.update(p.encode())
                with open(p, "rb") as fh:
                    h.update(fh.read())
    h.update(open(__file__, "rb").read())
    return h.hexdigest()


def build_agent(force: bool = False) -> str:
    """Compile + package the agent JAR. Returns its path. Raises on failure."""
    if not have_jdk():
        raise RuntimeError("javac/jar not on PATH — cannot build the -javaagent JAR")

    sig_file = os.path.join(DIST, ".sources.sha256")
    if not force and os.path.isfile(AGENT_JAR) and os.path.isfile(sig_file):
        try:
            if open(sig_file, encoding="utf-8").read().strip() == _sources_signature():
                return AGENT_JAR  # cache hit
        except OSError:
            pass

    os.makedirs(DIST, exist_ok=True)
    asm_paths = _download_asm()
    classpath = os.pathsep.join(asm_paths)

    # 1. Compile Java sources → build/classes
    classes_dir = os.path.join(HERE, "build", "classes")
    if os.path.isdir(classes_dir):
        shutil.rmtree(classes_dir)
    os.makedirs(classes_dir, exist_ok=True)
    sources = []
    for root, _dirs, files in os.walk(SRC):
        for f in files:
            if f.endswith(".java"):
                sources.append(os.path.join(root, f))
    cp_compile = _run(["javac", "-nowarn", "-cp", classpath, "-d", classes_dir, *sources])
    if cp_compile.returncode != 0:
        raise RuntimeError(f"javac failed:\n{cp_compile.stderr}")

    # 2. Shade ASM into the agent classes dir so the JAR is self-contained.
    shaded_dir = os.path.join(HERE, "build", "shaded")
    if os.path.isdir(shaded_dir):
        shutil.rmtree(shaded_dir)
    shutil.copytree(classes_dir, shaded_dir)
    for asm_jar in asm_paths:
        ex = _run(["jar", "xf", asm_jar], cwd=shaded_dir)
        if ex.returncode != 0:
            raise RuntimeError(f"could not extract {asm_jar}: {ex.stderr}")
    # Drop ASM's own META-INF manifests/services so they don't shadow ours.
    asm_meta = os.path.join(shaded_dir, "META-INF")
    if os.path.isdir(asm_meta):
        shutil.rmtree(asm_meta)

    # 3. Write the manifest (Premain-Class + Can-Retransform-Classes).
    meta_inf = os.path.join(shaded_dir, "META-INF")
    os.makedirs(meta_inf, exist_ok=True)
    manifest = (
        "Manifest-Version: 1.0\n"
        "Premain-Class: dreplay.agent.FlowAgent\n"
        "Can-Retransform-Classes: true\n"
        "Agent-Class: dreplay.agent.FlowAgent\n"
        "\n"
    )
    with open(os.path.join(meta_inf, "MANIFEST.MF"), "w", encoding="utf-8") as fh:
        fh.write(manifest)

    # 4. Package the shaded dir into the final JAR.
    pkg = _run(["jar", "cfm", AGENT_JAR, os.path.join(meta_inf, "MANIFEST.MF"),
                "-C", shaded_dir, "."])
    if pkg.returncode != 0:
        raise RuntimeError(f"jar packaging failed:\n{pkg.stderr}")

    with open(sig_file, "w", encoding="utf-8") as fh:
        fh.write(_sources_signature())
    return AGENT_JAR


if __name__ == "__main__":
    print(build_agent(force=True))
