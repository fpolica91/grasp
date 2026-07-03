"""dreplay flow-canary suite (FC1–FC5).

These pin the new product's contract (spec §8.1): the tool must surface observed
business-object facts, never verdicts, never guessed operands. Each scenario is a
real, minimal function the (future) interior instrumentation will trace; each test
asserts the observed flow it must produce. RED against the ``observe_flow`` stub
until §8.2 (instrumentation) lands.
"""
