"""Standing business-object corpus for continuous classifier calibration.

Unlike the minimal flow canaries (which pin specific contracts), these are realistic,
diverse DOMAIN modules — each with declared data models + a multi-call entrypoint —
that exercise the classifier on actual business objects across domains (billing, auth,
multi-tenant). Wired into the gate (tests/test_corpus.py) so a noise explosion or
under-show on business-object code is caught every run, deterministically — not waiting
on a human to run a real repo.
"""
