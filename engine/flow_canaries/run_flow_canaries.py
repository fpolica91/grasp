#!/usr/bin/env python3
"""Run the dreplay FLOW canary suite (spec §8.1) — the contract gate for the
behavioral-flow instrument.

Exit 0 = all flow canaries GREEN (the instrument surfaces the observed facts it
must); non-zero = a contract regression. Until §8.2 (interior instrumentation)
lands, FC1–FC4/FC5b are RED by design (``observe_flow`` raises rather than fake a
flow); FC5 (guessed-operand guard) is GREEN now.
"""
from __future__ import annotations

import subprocess
import sys


def main() -> int:
    cmd = [sys.executable, "-m", "pytest", "flow_canaries", "-q", "--tb=line"]
    print(">> dreplay flow canaries — contract gate (spec §8.1)", flush=True)
    rc = subprocess.call(cmd)
    if rc == 0:
        print(">> flow canaries GREEN")
    else:
        print(">> flow canaries RED (expected until §8.2 instrumentation lands)", file=sys.stderr)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
