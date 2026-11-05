"""Run the project's real Node regression suite from pytest."""
import subprocess
from pathlib import Path


def test_javascript_regressions():
    result = subprocess.run(["npm", "test"], cwd=Path(__file__).resolve().parents[1],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
