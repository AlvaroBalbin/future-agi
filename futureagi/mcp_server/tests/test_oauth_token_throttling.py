"""Tests for MCP OAuth token endpoint throttling."""

import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIRequestFactory

import mcp_server.throttles as throttles
from mcp_server import rate_limiter
from mcp_server.models.oauth_client import MCPOAuthClient
from mcp_server.models.oauth_code import MCPOAuthCode
from mcp_server.oauth_utils import hash_client_secret
from mcp_server.throttles import (
    MCPOAuthTokenIPThrottle,
    _invalid_attempt_key,
    record_invalid_token_attempt,
)
from mcp_server.views.oauth import MCPOAuthTokenView
from tfc.middleware.workspace_context import set_workspace_context

TOKEN_URL = "/mcp/oauth/token/"
CLIENT_SECRET = "correct-secret"

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def clear_throttle_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def oauth_client_app():
    return MCPOAuthClient.objects.create(
        client_id="test-oauth-client",
        client_secret_hash=hash_client_secret(CLIENT_SECRET),
        name="Test OAuth Client",
        redirect_uris=["https://example.com/callback"],
    )


def _create_auth_code(user, workspace, client):
    set_workspace_context(
        workspace=workspace,
        organization=user.organization,
        user=user,
    )
    return MCPOAuthCode.objects.create(
        code="valid-code",
        client=client,
        user=user,
        organization=user.organization,
        workspace=workspace,
        redirect_uri="https://example.com/callback",
        scope=["evaluations"],
    )


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="2/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="100/min",
)
def test_authorization_code_attempts_are_throttled_by_ip(api_client, oauth_client_app):
    payload = {
        "grant_type": "authorization_code",
        "code": "bad-code",
        "client_id": oauth_client_app.client_id,
        "client_secret": "wrong-secret",
        "redirect_uri": "https://example.com/callback",
    }

    first = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.10",
    )
    second = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.10",
    )
    third = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.10",
    )

    assert first.status_code == 401
    assert second.status_code == 401
    assert third.status_code == 429
    assert third.data["error"] == "slow_down"
    assert int(third["Retry-After"]) > 0


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="2/min",
)
def test_refresh_token_attempts_are_throttled_by_client_id_across_ips(
    api_client, oauth_client_app
):
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": "bad-refresh-token",
        "client_id": oauth_client_app.client_id,
        "client_secret": "wrong-secret",
    }

    first = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.21",
    )
    second = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.22",
    )
    third = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.23",
    )

    assert first.status_code == 401
    assert second.status_code == 401
    assert third.status_code == 429
    assert third.data["error"] == "slow_down"
    assert int(third["Retry-After"]) > 0


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="1/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="100/min",
)
def test_ip_throttle_counts_concurrent_requests_atomically():
    factory = APIRequestFactory()
    requests = [
        factory.post(
            TOKEN_URL,
            {"grant_type": "refresh_token", "client_id": "same-client"},
            format="json",
            REMOTE_ADDR="203.0.113.25",
        )
        for _ in range(2)
    ]

    def allow(request):
        return MCPOAuthTokenIPThrottle().allow_request(request, None)

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(allow, requests))

    assert sum(results) == 1


@pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs Redis")
def test_redis_throttle_script_counts_concurrent_requests_atomically():
    import redis

    client = redis.Redis.from_url(os.environ["REDIS_URL"])
    client.ping()
    script = client.register_script(rate_limiter._SINGLE_WINDOW_LUA)
    key = f"mcp_oauth_test:{uuid.uuid4().hex}"
    callers = 8
    barrier = Barrier(callers)

    def allow(_):
        barrier.wait()
        allowed, _oldest = script(
            keys=[key],
            args=[time.time(), 2, 60, uuid.uuid4().hex],
        )
        return int(allowed) == 1

    try:
        with ThreadPoolExecutor(max_workers=callers) as workers:
            assert sum(workers.map(allow, range(callers))) == 2
    finally:
        client.delete(key)


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT=2,
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_WINDOW_SECONDS=300,
    MCP_OAUTH_TOKEN_INVALID_LOCKOUT_SECONDS=60,
)
def test_repeated_invalid_refresh_grants_trigger_lockout(api_client, oauth_client_app):
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": "bad-refresh-token",
        "client_id": oauth_client_app.client_id,
        "client_secret": CLIENT_SECRET,
    }

    first = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.40",
    )
    second = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.40",
    )
    third = api_client.post(
        TOKEN_URL,
        payload,
        format="json",
        REMOTE_ADDR="203.0.113.40",
    )

    assert first.status_code == 400
    assert first.data["error"] == "invalid_grant"
    assert second.status_code == 400
    assert second.data["error"] == "invalid_grant"
    assert third.status_code == 429
    assert third.data["error"] == "slow_down"
    assert int(third["Retry-After"]) > 0


@override_settings(
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT=2,
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_WINDOW_SECONDS=300,
    MCP_OAUTH_TOKEN_INVALID_LOCKOUT_SECONDS=60,
)
def test_concurrent_invalid_attempts_set_lockout(oauth_client_app, monkeypatch):
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": "bad-refresh-token",
        "client_id": oauth_client_app.client_id,
        "client_secret": CLIENT_SECRET,
    }

    raw_request = APIRequestFactory().post(
        TOKEN_URL, payload, format="json", REMOTE_ADDR="203.0.113.41"
    )
    request = MCPOAuthTokenView().initialize_request(raw_request)
    attempt_key = _invalid_attempt_key(request)
    original_add = throttles.cache.add
    original_get = throttles.cache.get
    cache_barrier = Barrier(2)

    def synchronized_add(key, *args, **kwargs):
        if key == attempt_key:
            cache_barrier.wait(timeout=5)
        return original_add(key, *args, **kwargs)

    def synchronized_get(key, *args, **kwargs):
        if key == attempt_key:
            cache_barrier.wait(timeout=5)
        return original_get(key, *args, **kwargs)

    monkeypatch.setattr(throttles.cache, "add", synchronized_add)
    monkeypatch.setattr(throttles.cache, "get", synchronized_get)

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(
            workers.map(
                record_invalid_token_attempt,
                [request, request],
            )
        )

    assert sorted(result > 0 for result in results) == [False, True]
    assert throttles.get_invalid_attempt_lockout_wait(request) > 0


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="2/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="2/min",
)
def test_low_volume_authorization_code_exchange_is_allowed(
    api_client, user, workspace, oauth_client_app
):
    auth_code = _create_auth_code(user, workspace, oauth_client_app)

    response = api_client.post(
        TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": auth_code.code,
            "client_id": oauth_client_app.client_id,
            "client_secret": CLIENT_SECRET,
            "redirect_uri": auth_code.redirect_uri,
        },
        format="json",
        REMOTE_ADDR="203.0.113.30",
    )

    assert response.status_code == 200
    assert response.data["token_type"] == "Bearer"
    assert response.data["access_token"]
    assert response.data["refresh_token"]


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT=5,
)
def test_invalid_client_secret_returns_oauth_error_without_crashing(
    api_client, oauth_client_app
):
    response = api_client.post(
        TOKEN_URL,
        {
            "grant_type": "refresh_token",
            "refresh_token": "malformed-token",
            "client_id": oauth_client_app.client_id,
            "client_secret": "wrong-secret",
        },
        format="json",
        REMOTE_ADDR="203.0.113.50",
    )

    assert response.status_code == 401
    assert response.data["error"] == "invalid_client"


@override_settings(
    MCP_OAUTH_TOKEN_IP_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE="100/min",
    MCP_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT=5,
)
def test_invalid_refresh_token_returns_oauth_error_without_crashing(
    api_client, oauth_client_app
):
    response = api_client.post(
        TOKEN_URL,
        {
            "grant_type": "refresh_token",
            "refresh_token": "malformed-token",
            "client_id": oauth_client_app.client_id,
            "client_secret": CLIENT_SECRET,
        },
        format="json",
        REMOTE_ADDR="203.0.113.51",
    )

    assert response.status_code == 400
    assert response.data["error"] == "invalid_grant"
