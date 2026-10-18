"""Contract tests for the YAML and SDK word-information metrics."""

from __future__ import annotations

import builtins
import random
from functools import cache
from pathlib import Path

import pytest
import yaml

from agentic_eval.core_evals.fi_evals.function.functions import (
    _align_counts,
    calculate_word_info_lost,
    calculate_word_info_preserved,
)
from model_hub.management.commands.seed_system_evals import load_yaml_evals

FUNCTION_DIR = Path(__file__).resolve().parent.parent / "function"


@cache
def _load_eval(name: str):
    """Load one YAML body the same way the system-eval tests do."""
    path = FUNCTION_DIR / f"{name}.yaml"
    code = yaml.safe_load(path.read_text())["config"]["code"]
    namespace: dict = {}
    builtins.exec(compile(code, str(path), "exec"), namespace)
    return namespace["evaluate"]


def _yaml_score(name: str, hypothesis: str, reference: str) -> float:
    return _load_eval(name)(None, hypothesis, reference, None)["score"]


def _exhaustive_align_counts(reference: tuple[str, ...], hypothesis: tuple[str, ...]):
    """Return alignment counts without using dynamic programming.

    This is intentionally limited to the short sequences used by the
    randomized test. It provides an independent oracle for the production
    backtrace, including its documented tie-breaking order.
    """

    @cache
    def align(i: int, j: int):
        if i == 0 and j == 0:
            return 0, (), 0, 0, 0, 0

        candidates = []
        if i > 0 and j > 0:
            previous = align(i - 1, j - 1)
            is_hit = reference[i - 1] == hypothesis[j - 1]
            candidates.append(
                (
                    previous[0] + (0 if is_hit else 1),
                    (0 if is_hit else 1,) + previous[1],
                    previous[2] + int(is_hit),
                    previous[3] + int(not is_hit),
                    previous[4],
                    previous[5],
                )
            )
        if i > 0:
            previous = align(i - 1, j)
            candidates.append(
                (
                    previous[0] + 1,
                    (2,) + previous[1],
                    previous[2],
                    previous[3],
                    previous[4] + 1,
                    previous[5],
                )
            )
        if j > 0:
            previous = align(i, j - 1)
            candidates.append(
                (
                    previous[0] + 1,
                    (3,) + previous[1],
                    previous[2],
                    previous[3],
                    previous[4],
                    previous[5] + 1,
                )
            )

        return min(candidates, key=lambda candidate: (candidate[0], candidate[1]))

    return align(len(reference), len(hypothesis))[2:]


def _expected_score(
    reference: tuple[str, ...], hypothesis: tuple[str, ...], hits: int
) -> float:
    if not reference and not hypothesis:
        return 1.0
    if not reference or not hypothesis:
        return 0.0
    return (hits / len(reference)) * (hits / len(hypothesis))


@pytest.mark.parametrize(
    ("reference", "hypothesis", "expected"),
    [
        ("the cat sat", "the cat sat", 1.0),
        ("the cat sat", "the cat sat on the mat", 0.5),
        ("the cat sat", "the cat", 2 / 3),
        ("a b", "a c", 0.25),
        ("the cat sat down", "the big cat sat", 0.5625),
        ("a b", "c d", 0.0),
        ("a b a", "a a b", 1 / 9),
        ("", "", 1.0),
        ("", "extra words", 0.0),
        ("  A\n B  ", "a b", 1.0),
    ],
)
def test_yaml_and_sdk_scores_match_contract(reference, hypothesis, expected):
    """Both supported implementations must expose the same score."""
    assert _yaml_score("word_info_preserved", hypothesis, reference) == pytest.approx(
        expected
    )
    assert _yaml_score("word_info_lost", hypothesis, reference) == pytest.approx(
        expected
    )
    assert calculate_word_info_preserved(reference, hypothesis)[
        "result"
    ] == pytest.approx(expected)
    assert calculate_word_info_lost(reference, hypothesis)["result"] == pytest.approx(
        expected
    )


def test_system_eval_seeder_loads_both_word_information_templates():
    evals = {definition["name"]: definition for definition in load_yaml_evals()}

    for name, eval_id in (("word_info_lost", 190), ("word_info_preserved", 191)):
        definition = evals[name]
        assert definition["eval_id"] == eval_id
        assert definition["_track"] == "function"
        assert definition["config"]["eval_type_id"] == "CustomCodeEval"
        assert definition["config"]["required_keys"] == ["reference", "hypothesis"]


def test_alignment_matches_independent_oracle():
    rng = random.Random(3228)
    vocabulary = ("a", "b", "c")

    for _ in range(500):
        reference = tuple(rng.choice(vocabulary) for _ in range(rng.randrange(8)))
        hypothesis = tuple(rng.choice(vocabulary) for _ in range(rng.randrange(8)))
        expected_counts = _exhaustive_align_counts(reference, hypothesis)
        assert _align_counts(list(reference), list(hypothesis)) == expected_counts

        reference_text = " ".join(reference)
        hypothesis_text = " ".join(hypothesis)
        expected_score = _expected_score(reference, hypothesis, expected_counts[0])
        assert _yaml_score(
            "word_info_preserved", hypothesis_text, reference_text
        ) == pytest.approx(expected_score)
        assert _yaml_score(
            "word_info_lost", hypothesis_text, reference_text
        ) == pytest.approx(expected_score)
        assert calculate_word_info_preserved(reference_text, hypothesis_text)[
            "result"
        ] == pytest.approx(expected_score)
        assert calculate_word_info_lost(reference_text, hypothesis_text)[
            "result"
        ] == pytest.approx(expected_score)
