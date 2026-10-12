"""Real ClickHouse proof that Observe count tiles count each span once.

A count tile reads the span's newest completed eval row, the row the
trace-detail rollup shows. Reruns must not add to the count, a newer errored
row must not displace a completed one, and a tombstoned newest row falls back
to the previous live result. The percentage path keeps every attempt.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from conftest import _ch_test_native_client
from tracer.services.clickhouse import eval_logger_table as eval_logger_table_config
from tracer.services.clickhouse.query_builders.span_list import SpanListQueryBuilder
from tracer.services.clickhouse.v2.query_builders.trace_list import (
    TraceListQueryBuilderV2,
)
from tracer.services.clickhouse.v2.query_builders.voice_call_list import (
    VoiceCallListQueryBuilderV2,
)

pytestmark = pytest.mark.integration

PROJECT_ID = "00000000-0000-4000-8000-000000000001"
TRACE_ID = str(uuid.uuid4())
PASS_FAIL = str(uuid.uuid4())
CHOICES = str(uuid.uuid4())
T0 = datetime(2026, 10, 1, 12, 0, 0)


@pytest.fixture(scope="module")
def ch_client():
    with _ch_test_native_client() as client:
        yield client


@pytest.fixture()
def eval_table(ch_client, monkeypatch):
    table = f"_test_eval_counts_{uuid.uuid4().hex[:8]}_v2"

    def test_eval_source(alias="", include_cdc_tombstone_guard=False):
        del include_cdc_tombstone_guard
        prefix = f"{alias}." if alias else ""
        return table, f"{prefix}is_deleted = 0"

    for builder in (
        TraceListQueryBuilderV2,
        SpanListQueryBuilder,
        VoiceCallListQueryBuilderV2,
    ):
        monkeypatch.setattr(
            builder, "_EVAL_LOGGER_SOURCE", staticmethod(test_eval_source)
        )
    monkeypatch.setattr(
        eval_logger_table_config,
        "SUPPORTED_EVAL_LOGGER_TABLES",
        eval_logger_table_config.SUPPORTED_EVAL_LOGGER_TABLES | {table},
    )
    ch_client.execute(
        f"""
        CREATE TABLE {table} (
            id UUID,
            trace_id Nullable(UUID),
            observation_span_id Nullable(String),
            custom_eval_config_id UUID,
            output_bool Nullable(UInt8),
            output_float Nullable(Float64),
            output_str Nullable(String),
            output_str_list String DEFAULT '[]',
            error UInt8,
            target_type LowCardinality(String) DEFAULT 'span',
            created_at DateTime64(6),
            is_deleted UInt8,
            _version UInt64
        ) ENGINE = MergeTree ORDER BY (id, _version)
        """
    )
    rows = []

    def add(span_id, config, minutes, *, ok=None, labels=None, error=0,
            row_id=None, deleted=0, version=1):
        rows.append(
            (
                uuid.UUID(row_id) if row_id else uuid.uuid4(),
                uuid.UUID(TRACE_ID),
                span_id,
                uuid.UUID(config),
                ok,
                None,
                "ERROR" if error else None,
                json.dumps(labels or []),
                error,
                "span",
                T0 + timedelta(minutes=minutes),
                deleted,
                version,
            )
        )

    # span-a: pass, then a fail whose newest physical version is a tombstone.
    add("span-a", PASS_FAIL, 1, ok=1)
    deleted_fail = str(uuid.uuid4())
    add("span-a", PASS_FAIL, 2, ok=0, row_id=deleted_fail)
    add("span-a", PASS_FAIL, 2, ok=0, row_id=deleted_fail, deleted=1, version=2)
    # span-b: pass, rerun to fail, then a newer errored attempt.
    add("span-b", PASS_FAIL, 1, ok=1)
    add("span-b", PASS_FAIL, 2, ok=0)
    add("span-b", PASS_FAIL, 3, error=1)
    # A choice eval rerun on span-b.
    add("span-b", CHOICES, 1, labels=["clear"])
    add("span-b", CHOICES, 2, labels=["unclear"])

    ch_client.execute(
        f"""
        INSERT INTO {table} (id, trace_id, observation_span_id,
            custom_eval_config_id, output_bool, output_float, output_str,
            output_str_list, error, target_type, created_at, is_deleted,
            _version) VALUES
        """,
        rows,
    )
    try:
        yield table
    finally:
        ch_client.execute(f"DROP TABLE {table}")


def _run(ch_client, query, params):
    data, columns = ch_client.execute(query, params, with_column_types=True)
    names = [name for name, _type in columns]
    return [dict(zip(names, row, strict=True)) for row in data]


def _by_config(rows):
    return {str(row["eval_config_id"]): row for row in rows}


def test_trace_count_tiles_count_each_span_once(ch_client, eval_table):
    builder = TraceListQueryBuilderV2(
        project_id=PROJECT_ID, eval_config_ids=[PASS_FAIL, CHOICES]
    )

    counted = _by_config(
        _run(ch_client, *builder.build_eval_query([TRACE_ID], count_mode=True))
    )
    # span-a falls back to its live pass; span-b reads its rerun fail.
    assert counted[PASS_FAIL]["pass_count"] == 1
    assert counted[PASS_FAIL]["fail_count"] == 1
    assert counted[PASS_FAIL]["success_count"] == 2
    assert counted[PASS_FAIL]["error_count"] == 1
    assert [json.loads(labels) for labels in counted[CHOICES]["str_lists"]] == [
        ["unclear"]
    ]

    # The percentage path, used outside Observe, still averages every attempt.
    averaged = _by_config(
        _run(ch_client, *builder.build_eval_query([TRACE_ID], count_mode=False))
    )
    assert averaged[PASS_FAIL]["success_count"] == 3
    assert averaged[PASS_FAIL]["pass_rate"] == pytest.approx(200 / 3)


def test_span_count_tiles_read_the_newest_completed_result(ch_client, eval_table):
    builder = SpanListQueryBuilder(
        project_id=PROJECT_ID, eval_config_ids=[PASS_FAIL, CHOICES]
    )
    query, params = builder.build_eval_query(["span-a", "span-b"], count_mode=True)
    rows = {
        (row["observation_span_id"], str(row["eval_config_id"])): row
        for row in _run(ch_client, query, params)
    }

    assert rows[("span-a", PASS_FAIL)]["pass_count"] == 1
    assert rows[("span-a", PASS_FAIL)]["fail_count"] == 0
    assert rows[("span-b", PASS_FAIL)]["pass_count"] == 0
    assert rows[("span-b", PASS_FAIL)]["fail_count"] == 1
    assert rows[("span-b", PASS_FAIL)]["error_count"] == 1
    assert [
        json.loads(labels) for labels in rows[("span-b", CHOICES)]["str_lists"]
    ] == [["unclear"]]


def test_voice_call_count_tiles_count_each_span_once(ch_client, eval_table):
    builder = VoiceCallListQueryBuilderV2(
        project_id=PROJECT_ID, eval_config_ids=[PASS_FAIL, CHOICES]
    )

    counted = _by_config(
        _run(ch_client, *builder.build_eval_query([TRACE_ID], count_mode=True))
    )
    assert counted[PASS_FAIL]["pass_count"] == 1
    assert counted[PASS_FAIL]["fail_count"] == 1
    assert counted[PASS_FAIL]["error_count"] == 1
    assert counted[PASS_FAIL]["target_type"] == "span"
    assert [json.loads(labels) for labels in counted[CHOICES]["str_lists"]] == [
        ["unclear"]
    ]

    averaged = _by_config(
        _run(ch_client, *builder.build_eval_query([TRACE_ID]))
    )
    assert averaged[PASS_FAIL]["success_count"] == 3
    assert "pass_count" not in averaged[PASS_FAIL]
