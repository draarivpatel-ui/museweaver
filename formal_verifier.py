"""Exact, fail-closed verification of a restricted agent proposal DSL.

These proofs cover the specified transition relation, not arbitrary source code.
Run python formal_verifier.py for a free, local Z3 demonstration.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass

import z3

UNIT = 1_000_000


@dataclass(frozen=True)
class Proof:
    status: str
    scope: str
    elapsed_ms: float
    counterexample: dict[str, int | bool] | None
    solver: str = "Z3"

    @property
    def verified(self) -> bool:
        return self.status == "unsat"


def _check(solver: z3.Solver, scope: str, symbols: dict) -> Proof:
    solver.set(timeout=2000)
    started = time.perf_counter_ns()
    status = solver.check()
    witness = None
    if status == z3.sat:
        model = solver.model()
        witness = {}
        for name, symbol in symbols.items():
            value = model.eval(symbol, model_completion=True)
            witness[name] = z3.is_true(value) if z3.is_bool(value) else value.as_long()
    return Proof(str(status), scope, (time.perf_counter_ns() - started) / 1e6, witness)


def prove_token_transition(
    *, clamp: bool = True, debit: int = UNIT, inclusive: bool = True
) -> Proof:
    """Prove single-step bounds, admission and exact integer refinement.

    Delta is any nonnegative integer microtoken refill. This avoids treating
    floating-point arithmetic or bounded fuzzing as a mathematical proof.
    """
    if type(clamp) is not bool or type(inclusive) is not bool or type(debit) is not int:
        raise ValueError("Proposal parameters must be boolean, integer, boolean")
    capacity, balance, delta = z3.Ints("capacity balance delta")
    limit = capacity * UNIT
    reference = z3.If(balance + delta > limit, limit, balance + delta)
    refill = reference if clamp else balance + delta
    admit = refill >= UNIT if inclusive else refill > UNIT
    after = z3.If(admit, refill - debit, refill)
    reference_admit = reference >= UNIT
    reference_after = z3.If(reference_admit, reference - UNIT, reference)
    solver = z3.Solver()
    solver.add(capacity >= 1, balance >= 0, balance <= limit, delta >= 0)
    solver.add(z3.Not(z3.And(
        after >= 0, after <= limit,
        admit == reference_admit, after == reference_after,
    )))
    return _check(solver, "unbounded integer token transition refinement",
                  {"capacity": capacity, "balance": balance, "delta": delta,
                   "admitted": admit, "after": after})


def prove_quorum(n: int, f: int, q: int) -> Proof:
    """Verify safety AND availability, not intersection alone.

    The cardinality lower bound for two q-quorums is 2q-n. At most f shared
    members can be Byzantine. Availability requires q <= n-f.
    """
    if any(type(v) is not int for v in (n, f, q)) or not (n >= 1 and 0 <= f < n and 1 <= q <= n):
        raise ValueError("Require integers n >= 1, 0 <= f < n, 1 <= q <= n")
    intersection, byzantine, failures = z3.Ints("intersection byzantine failures")
    solver = z3.Solver()
    solver.add(intersection >= max(0, 2 * q - n), intersection <= q)
    solver.add(byzantine >= 0, byzantine <= f, byzantine <= intersection)
    solver.add(failures >= 0, failures <= f)
    solver.add(z3.Or(intersection - byzantine <= 0, n - failures < q))
    return _check(solver, "quorum honest intersection and crash availability",
                  {"intersection": intersection, "byzantine": byzantine, "failures": failures})


def verify_proposal(proposal: dict) -> Proof:
    """Reject unspecified languages, extra fields and malformed candidate values."""
    if not isinstance(proposal, dict) or "kind" not in proposal:
        raise ValueError("A structured proposal is required")
    if proposal["kind"] == "token_bucket":
        if set(proposal) != {"kind", "clamp", "debit", "inclusive"}:
            raise ValueError("Unexpected token proposal fields")
        return prove_token_transition(clamp=proposal["clamp"], debit=proposal["debit"],
                                      inclusive=proposal["inclusive"])
    if proposal["kind"] == "quorum" and set(proposal) == {"kind", "n", "f", "q"}:
        return prove_quorum(proposal["n"], proposal["f"], proposal["q"])
    raise ValueError("Unsupported proposal schema")


def demo() -> dict:
    cases = {
        "exact_integer_bucket": prove_token_transition(),
        "missing_capacity_clamp": prove_token_transition(clamp=False),
        "incorrect_debit": prove_token_transition(debit=UNIT + 1),
        "strict_admission_boundary": prove_token_transition(inclusive=False),
        "safe_quorum": prove_quorum(7, 2, 5),
        "split_brain_threshold": prove_quorum(6, 2, 4),
        "safe_but_unavailable": prove_quorum(6, 2, 5),
    }
    return {name: {**asdict(proof), "verified": proof.verified} for name, proof in cases.items()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proposal", help="JSON proposal file; no code is executed")
    args = parser.parse_args()
    if args.proposal:
        from pathlib import Path
        result = verify_proposal(json.loads(Path(args.proposal).read_text()))
        print(json.dumps({**asdict(result), "verified": result.verified}, indent=2))
        raise SystemExit(0 if result.verified else 1)
    print(json.dumps(demo(), indent=2))
