"""Throttle helpers for MCP public authentication endpoints."""

import hashlib
import time

from django.conf import settings
from django.core.cache import cache
from rest_framework.exceptions import APIException, Throttled
from rest_framework.throttling import SimpleRateThrottle

from mcp_server.constants import (
    DEFAULT_OAUTH_TOKEN_CLIENT_RATE,
    DEFAULT_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT,
    DEFAULT_OAUTH_TOKEN_INVALID_ATTEMPT_WINDOW_SECONDS,
    DEFAULT_OAUTH_TOKEN_INVALID_LOCKOUT_SECONDS,
    DEFAULT_OAUTH_TOKEN_IP_RATE,
)
from mcp_server.rate_limiter import check_sliding_window


def stable_hash(value: str, length: int | None = None) -> str:
    """Return a deterministic hash for cache keys and non-secret log labels."""
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return digest[:length] if length else digest


def request_data_value(request, key: str) -> str:
    value = request.data.get(key, "")
    return str(value).strip() if value is not None else ""


def oauth_token_attempt_ident(request) -> str:
    grant_type = request_data_value(request, "grant_type") or "unknown"
    client_id = request_data_value(request, "client_id") or "unknown"
    remote_addr = request.META.get("REMOTE_ADDR", "") or "unknown"
    return stable_hash(f"{remote_addr}:{grant_type}:{client_id}")


def _invalid_attempt_key(request) -> str:
    return f"mcp_oauth_token_invalid:{oauth_token_attempt_ident(request)}"


def _invalid_lockout_key(request) -> str:
    return f"mcp_oauth_token_invalid_lock:{oauth_token_attempt_ident(request)}"


def get_invalid_attempt_lockout_wait(request) -> int:
    locked_until = cache.get(_invalid_lockout_key(request))
    if not locked_until:
        return 0

    wait = int(locked_until - time.time()) + 1
    return max(wait, 0)


def record_invalid_token_attempt(request) -> int:
    limit = int(
        getattr(
            settings,
            "MCP_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT",
            DEFAULT_OAUTH_TOKEN_INVALID_ATTEMPT_LIMIT,
        )
    )
    window_seconds = int(
        getattr(
            settings,
            "MCP_OAUTH_TOKEN_INVALID_ATTEMPT_WINDOW_SECONDS",
            DEFAULT_OAUTH_TOKEN_INVALID_ATTEMPT_WINDOW_SECONDS,
        )
    )
    lockout_seconds = int(
        getattr(
            settings,
            "MCP_OAUTH_TOKEN_INVALID_LOCKOUT_SECONDS",
            DEFAULT_OAUTH_TOKEN_INVALID_LOCKOUT_SECONDS,
        )
    )

    attempt_key = _invalid_attempt_key(request)
    if cache.add(attempt_key, 1, timeout=window_seconds):
        attempts = 1
    else:
        try:
            attempts = cache.incr(attempt_key)
        except ValueError:
            # Recover if the window expired between add() and incr().
            cache.set(attempt_key, 1, timeout=window_seconds)
            attempts = 1

    if attempts < limit:
        return 0

    locked_until = time.time() + lockout_seconds
    cache.set(
        _invalid_lockout_key(request),
        locked_until,
        timeout=lockout_seconds,
    )
    return lockout_seconds


class MCPOAuthTokenThrottled(Throttled):
    """OAuth-shaped 429 exception that still receives DRF retry headers."""

    def __init__(self, wait):
        self.wait = wait
        APIException.__init__(
            self,
            {
                "error": "slow_down",
                "error_description": "Too many token requests",
            },
            "throttled",
        )


class AtomicRateThrottle(SimpleRateThrottle):
    """Count requests with the shared atomic sliding-window limiter."""

    cache_format = "mcp_oauth_token_throttle_v2_%(scope)s_%(ident)s"

    def allow_request(self, request, view):
        if self.rate is None:
            return True

        self.key = self.get_cache_key(request, view)
        if self.key is None:
            return True

        self.now = self.timer()
        allowed, oldest = check_sliding_window(
            self.key,
            self.num_requests,
            self.duration,
            now=self.now,
        )
        if allowed:
            self._wait = None
            return True

        self._wait = max(int(self.duration - (self.now - oldest)) + 1, 1)
        return False

    def wait(self):
        return getattr(self, "_wait", None)


class MCPOAuthTokenIPThrottle(AtomicRateThrottle):
    """Rate-limit token exchange attempts from the same remote address."""

    scope = "mcp_oauth_token_ip"

    def get_rate(self):
        return getattr(
            settings,
            "MCP_OAUTH_TOKEN_IP_THROTTLE_RATE",
            DEFAULT_OAUTH_TOKEN_IP_RATE,
        )

    def get_cache_key(self, request, view):
        ident = stable_hash(self.get_ident(request))
        return self.cache_format % {"scope": self.scope, "ident": ident}


class MCPOAuthTokenClientThrottle(AtomicRateThrottle):
    """Rate-limit token exchange attempts for the same client and grant type."""

    scope = "mcp_oauth_token_client"

    def get_rate(self):
        return getattr(
            settings,
            "MCP_OAUTH_TOKEN_CLIENT_THROTTLE_RATE",
            DEFAULT_OAUTH_TOKEN_CLIENT_RATE,
        )

    def get_cache_key(self, request, view):
        client_id = request_data_value(request, "client_id")
        if not client_id:
            return None

        grant_type = request_data_value(request, "grant_type") or "unknown"
        ident = stable_hash(f"{grant_type}:{client_id}")
        return self.cache_format % {"scope": self.scope, "ident": ident}
