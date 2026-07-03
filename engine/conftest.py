"""Root conftest — ensures the repo root is importable so both `dreplay` and
`canaries` resolve without an editable install."""
import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
