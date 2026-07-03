"""Language adapters — the flow instrument's per-language tracers.

Each ``*_flow`` module (``go_flow``, ``java_flow``, ``csharp_flow``, ``cpp_flow``,
``node_flow``, ``ts_flow``) is imported directly by module path from
``flow_cli`` / ``instrument`` and emits the SAME Flow-JSON protocol
(``{events, constants, defined_funcs, return, exception}``) that ``instrument._reduce``
funnels into ``Flow`` of ``Node``\\s. This package is just the namespace marker; there is
no differ ``ExecutionAdapter`` registry here anymore (that was the retired differ half).
"""
from __future__ import annotations
