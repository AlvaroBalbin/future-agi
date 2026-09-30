"""Golden tests for the matthews_correlation system eval.

Expected MCC values are from sklearn.metrics.matthews_corrcoef.
"""

from __future__ import annotations

import builtins
from pathlib import Path

import pytest
import yaml

YAML_PATH = (
    Path(__file__).resolve().parent.parent / "function" / "matthews_correlation.yaml"
)


def _mcc(output, expected):
    code = yaml.safe_load(YAML_PATH.read_text())["config"]["code"]
    ns: dict = {}
    vars(builtins)["exec"](compile(code, str(YAML_PATH), "exec"), ns)
    return ns["evaluate"](None, output, expected, None)["score"] * 2 - 1


@pytest.mark.parametrize(
    ("output", "expected", "mcc"),
    [
        (["a", "a", "a", "b", "c"], ["a", "b", "c", "b", "c"], 0.534522),
        (["x", "y", "z", "x"], ["x", "y", "z", "y"], 0.7),
        (["a", "b", "c"], ["a", "b", "c"], 1.0),
        (["a", "a", "a"], ["a", "b", "c"], 0.0),
        (["1", "1", "0", "0"], ["1", "0", "1", "0"], 0.0),
    ],
    ids=["multiclass", "multiclass-2", "perfect", "constant-prediction", "binary"],
)
def test_matches_sklearn(output, expected, mcc):
    assert _mcc(output, expected) == pytest.approx(mcc, abs=1e-6)
