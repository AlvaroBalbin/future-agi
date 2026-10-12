"""The voice-call drawer reads each span's newest completed eval result."""

from tracer.views.trace import _pivot_voice_detail_eval_rows


def _row(log_id, minutes, **values):
    return {
        "span_id": "root",
        "eval_config_id": "helpful",
        "status": "completed",
        "error": 0,
        "created_at": f"2026-10-01T12:{minutes:02d}:00",
        "log_id": log_id,
        **values,
    }


def test_a_rerun_replaces_the_earlier_result_for_its_span():
    pivoted = _pivot_voice_detail_eval_rows(
        [
            _row("a", 1, output_bool=True),
            _row("b", 2, output_bool=False),
            _row("c", 3, error=1, output_str="ERROR"),
        ]
    )

    assert pivoted["helpful"]["pass_rate"] == 0.0
    assert pivoted["helpful"]["count"] == 1


def test_each_span_still_counts_once():
    pivoted = _pivot_voice_detail_eval_rows(
        [
            _row("a", 1, output_bool=True),
            _row("b", 2, output_bool=False, span_id="turn-1"),
            {**_row("c", 1, output_str_list='["clear"]'), "eval_config_id": "tone"},
            {**_row("d", 2, output_str_list='["unclear"]'), "eval_config_id": "tone"},
        ]
    )

    assert pivoted["helpful"]["pass_rate"] == 50.0
    assert pivoted["tone"]["per_choice"] == {"unclear": 100.0}
