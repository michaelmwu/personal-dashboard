"""Read-only loopback proxy for the Personal Dashboard host summary.

Hermes Dashboard owns browser authentication.  This route deliberately has no
request argument and never relays browser cookies, authorization headers, or
other session material to the dashboard service.  It fetches one fixed,
read-only endpoint from a literal loopback origin instead.
"""

import asyncio
import ipaddress
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import APIRouter, HTTPException


DEFAULT_DASHBOARD_API_BASE_URL = "http://127.0.0.1:8810"
SUMMARY_PATH = "/api/host-dashboard/summary"
MAX_RESPONSE_BYTES = 256 * 1024
REQUEST_TIMEOUT_SECONDS = 2.0

router = APIRouter()


class _ProxyConfigurationError(Exception):
    """The configured upstream is not an allowed loopback origin."""


class _SummaryUnavailable(Exception):
    """The fixed dashboard summary could not be read or validated."""


class _NoRedirect(HTTPRedirectHandler):
    """Keep a loopback fetch from becoming a request to an arbitrary URL."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        del request, fp, code, msg, headers, newurl
        return None


_HTTP_OPENER = build_opener(_NoRedirect())


def _is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _summary_url(env: dict[str, str] | None = None) -> str:
    environment = os.environ if env is None else env
    configured = environment.get(
        "PERSONAL_DASHBOARD_PLUGIN_API_BASE_URL",
        DEFAULT_DASHBOARD_API_BASE_URL,
    ).strip()

    try:
        parsed = urlsplit(configured)
        port = parsed.port
    except ValueError as error:
        raise _ProxyConfigurationError from error

    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or not _is_loopback_host(parsed.hostname)
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise _ProxyConfigurationError

    base_url = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{base_url.rstrip('/')}{SUMMARY_PATH}"


def _is_host_summary(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if not isinstance(payload.get("version"), str) or not payload["version"].strip():
        return False
    if not isinstance(payload.get("generatedAt"), str) or not payload["generatedAt"].strip():
        return False

    health = payload.get("health")
    if not isinstance(health, dict):
        return False
    if not isinstance(health.get("level"), str) or not isinstance(health.get("summary"), str):
        return False

    return all(isinstance(payload.get(key), list) for key in ("metrics", "alerts", "travel", "tasks"))


def _fetch_summary() -> dict[str, Any]:
    url = _summary_url()
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "personal-dashboard-hermes-plugin/0.1",
        },
        method="GET",
    )

    try:
        with _HTTP_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise _SummaryUnavailable

            content_type = response.headers.get_content_type().lower()
            if content_type != "application/json":
                raise _SummaryUnavailable

            body = response.read(MAX_RESPONSE_BYTES + 1)
    except _ProxyConfigurationError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
        raise _SummaryUnavailable from error

    if len(body) > MAX_RESPONSE_BYTES:
        raise _SummaryUnavailable

    try:
        payload = json.loads(body)
    except (TypeError, ValueError) as error:
        raise _SummaryUnavailable from error

    if not _is_host_summary(payload):
        raise _SummaryUnavailable
    return payload


@router.get("/summary")
async def get_summary() -> dict[str, Any]:
    """Return the fixed, validated host summary without exposing upstream details."""

    try:
        return await asyncio.to_thread(_fetch_summary)
    except _ProxyConfigurationError as error:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "personal_dashboard_proxy_not_configured",
                "message": "The Personal Dashboard summary proxy is not configured.",
            },
        ) from error
    except _SummaryUnavailable as error:
        raise HTTPException(
            status_code=502,
            detail={
                "error": "personal_dashboard_summary_unavailable",
                "message": "The Personal Dashboard summary is unavailable.",
            },
        ) from error
