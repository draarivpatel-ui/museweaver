import importlib.util
import sys
from pathlib import Path

import pytest

path = Path(__file__).resolve().parents[1] / "formal_verifier.py"
spec = importlib.util.spec_from_file_location("muse_formal_test", path)
formal = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = formal
spec.loader.exec_module(formal)


@pytest.mark.parametrize("clamp,debit,inclusive,expected", [
    (True, 1000000, True, True), (False, 1000000, True, False),
    (True, 999999, True, False), (True, 1000001, True, False),
    (True, 1000000, False, False), (True, 0, True, False),
])
def test_real_z3_transition_proofs(clamp, debit, inclusive, expected):
    proof = formal.prove_token_transition(clamp=clamp, debit=debit, inclusive=inclusive)
    assert proof.verified is expected
    assert (proof.counterexample is None) is expected


def test_quorum_safety_and_availability_exhaustive_small_configs():
    for n in range(1, 11):
        for f in range(n):
            for q in range(1, n + 1):
                expected = 2 * q - n > f and q <= n - f
                assert formal.prove_quorum(n, f, q).verified is expected


@pytest.mark.parametrize("proposal", [
    {}, {"kind": "python", "code": "pass"},
    {"kind": "token_bucket", "clamp": 1, "debit": 1000000, "inclusive": True},
    {"kind": "quorum", "n": 0, "f": 0, "q": 0},
])
def test_unknown_and_malformed_proposals_fail_closed(proposal):
    with pytest.raises(ValueError):
        formal.verify_proposal(proposal)
