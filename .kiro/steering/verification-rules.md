# Kiro Steering Rules - MuseWeaver Verification Studio

1. **Exact Integer & DP Invariants:** Never use IEEE-754 floating-point accumulators for token-bucket rate limiters (`C, R` scaled to integer micro-tokens) or greedy heuristics where non-convex transition penalties require dynamic programming.
2. **Deterministic Reproducibility:** Every fuzz trial must use a deterministic PRNG seed so judges can reproduce exact counterexamples in one click.
