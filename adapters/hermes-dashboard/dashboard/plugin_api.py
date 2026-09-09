"""Fixed loopback proxy for Personal Dashboard viewports and flight interventions.

Hermes Dashboard owns browser authentication. Read-only viewports need no
upstream credential. Award-flight status and human challenge actions use a
systemd credential derived for this single purpose; the plugin never receives
the general dashboard API token or Flight Searcher owner token.
"""

import asyncio
import ipaddress
import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import APIRouter, HTTPException, Response


DEFAULT_DASHBOARD_API_BASE_URL = "http://127.0.0.1:8810"
SUMMARY_PATH = "/api/host-dashboard/summary"
VIEWPORT_PATHS = {
    "overview": "/api/host-dashboard/overview",
    "hotel-rate-finder": "/api/host-dashboard/hotel-rate-finder",
    "asia-travel-deals": "/api/host-dashboard/asia-travel-deals",
}
FLIGHT_SEARCHES_PATH = "/api/hermes/flight-searches"
FLIGHT_CREDENTIAL_NAME = "personal-dashboard-flight-intervention-token"
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_RESPONSE_BYTES = 512 * 1024
MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 5.0

router = APIRouter()


class _ProxyConfigurationError(Exception):
    """The configured upstream or credential is not allowed."""


class _UpstreamUnavailable(Exception):
    """The fixed dashboard request failed or returned invalid data."""


class _NoRedirect(HTTPRedirectHandler):
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


def _upstream_url(path: str, env: dict[str, str] | None = None) -> str:
    environment = os.environ if env is None else env
    configured = environment.get(
        "PERSONAL_DASHBOARD_PLUGIN_API_BASE_URL", DEFAULT_DASHBOARD_API_BASE_URL
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
    return f"{base_url.rstrip('/')}{path}"


def _credential(env: dict[str, str] | None = None) -> str:
    environment = os.environ if env is None else env
    directory = environment.get("CREDENTIALS_DIRECTORY", "").strip()
    if not directory or not os.path.isabs(directory):
        raise _ProxyConfigurationError
    try:
        with open(  # noqa: PTH123 - systemd credentials are absolute runtime files.
            os.path.join(directory, FLIGHT_CREDENTIAL_NAME), encoding="utf-8"
        ) as credential_file:
            token = credential_file.read().strip()
    except (OSError, UnicodeError) as error:
        raise _ProxyConfigurationError from error
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise _ProxyConfigurationError
    return token


def _request(path: str, *, method: str = "GET", payload: Any = None, authenticated: bool = False):
    headers = {
        "Accept": "application/json",
        "User-Agent": "personal-dashboard-hermes-plugin/0.2",
    }
    body = None
    if authenticated:
        headers["Authorization"] = f"Bearer {_credential()}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return Request(_upstream_url(path), headers=headers, data=body, method=method)


def _read_response(request: Request, max_bytes: int = MAX_RESPONSE_BYTES) -> tuple[bytes, str]:
    try:
        with _HTTP_OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status < 200 or response.status >= 300:
                raise _UpstreamUnavailable
            content_type = response.headers.get_content_type().lower()
            body = response.read(max_bytes + 1)
    except _ProxyConfigurationError:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
        raise _UpstreamUnavailable from error
    if len(body) > max_bytes:
        raise _UpstreamUnavailable
    return body, content_type


def _fetch_json(request: Request, validator: Any) -> dict[str, Any]:
    body, content_type = _read_response(request)
    if content_type != "application/json":
        raise _UpstreamUnavailable
    try:
        payload = json.loads(body)
    except (TypeError, ValueError) as error:
        raise _UpstreamUnavailable from error
    if not validator(payload):
        raise _UpstreamUnavailable
    return payload


def _is_host_summary(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("version"), str)
        and isinstance(payload.get("generatedAt"), str)
        and isinstance(payload.get("health"), dict)
        and all(isinstance(payload.get(key), list) for key in ("metrics", "alerts", "travel", "tasks"))
    )


def _is_host_viewport(payload: Any, viewport: str) -> bool:
    if not (
        isinstance(payload, dict)
        and payload.get("version") == "host-dashboard-viewport.v1"
        and payload.get("viewport") == viewport
        and isinstance(payload.get("generatedAt"), str)
        and isinstance(payload.get("health"), dict)
        and isinstance(payload.get("source"), dict)
    ):
        return False
    if viewport == "overview":
        return all(isinstance(payload.get(key), list) for key in ("metrics", "alerts", "travel", "tasks"))
    return isinstance(payload.get("items"), list)


def _is_flight_feed(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("ok"), bool)
        and payload.get("emailAccess") is False
        and isinstance(payload.get("searches"), list)
    )


def _valid_identifier(value: str) -> bool:
    return bool(IDENTIFIER.fullmatch(value))


def _proxy_error(error: Exception) -> HTTPException:
    if isinstance(error, _ProxyConfigurationError):
        return HTTPException(
            status_code=503,
            detail={"error": "personal_dashboard_proxy_not_configured", "message": "The dashboard proxy credential is unavailable."},
        )
    return HTTPException(
        status_code=502,
        detail={"error": "personal_dashboard_upstream_unavailable", "message": "The Personal Dashboard service is unavailable."},
    )


async def _json_call(request: Request, validator: Any) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_fetch_json, request, validator)
    except (_ProxyConfigurationError, _UpstreamUnavailable) as error:
        raise _proxy_error(error) from error


@router.get("/summary")
async def get_summary() -> dict[str, Any]:
    return await _json_call(_request(SUMMARY_PATH), _is_host_summary)


@router.get("/overview")
async def get_overview() -> dict[str, Any]:
    return await _json_call(_request(VIEWPORT_PATHS["overview"]), lambda value: _is_host_viewport(value, "overview"))


@router.get("/hotel-rate-finder")
async def get_hotel_rate_finder() -> dict[str, Any]:
    return await _json_call(_request(VIEWPORT_PATHS["hotel-rate-finder"]), lambda value: _is_host_viewport(value, "hotel-rate-finder"))


@router.get("/asia-travel-deals")
async def get_asia_travel_deals() -> dict[str, Any]:
    return await _json_call(_request(VIEWPORT_PATHS["asia-travel-deals"]), lambda value: _is_host_viewport(value, "asia-travel-deals"))


@router.get("/flight-searches")
async def get_flight_searches() -> dict[str, Any]:
    return await _json_call(_request(f"{FLIGHT_SEARCHES_PATH}?limit=20", authenticated=True), _is_flight_feed)


@router.get("/flight-searches/{job_id}/challenges/{challenge_id}/screenshot")
async def get_flight_screenshot(job_id: str, challenge_id: str) -> Response:
    if not _valid_identifier(job_id) or not _valid_identifier(challenge_id):
        raise HTTPException(status_code=400, detail={"error": "invalid_flight_identifier"})
    try:
        body, content_type = await asyncio.to_thread(
            _read_response,
            _request(f"{FLIGHT_SEARCHES_PATH}/{job_id}/challenges/{challenge_id}/screenshot", authenticated=True),
            MAX_SCREENSHOT_BYTES,
        )
    except (_ProxyConfigurationError, _UpstreamUnavailable) as error:
        raise _proxy_error(error) from error
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=502, detail={"error": "invalid_challenge_screenshot"})
    return Response(content=body, media_type=content_type, headers={"Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff"})


@router.post("/flight-searches/{job_id}/challenges/{challenge_id}/respond")
async def respond_to_flight_challenge(job_id: str, challenge_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not _valid_identifier(job_id) or not _valid_identifier(challenge_id):
        raise HTTPException(status_code=400, detail={"error": "invalid_flight_identifier"})
    value = payload.get("value")
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 256:
        raise HTTPException(status_code=400, detail={"error": "invalid_challenge_value"})
    return await _json_call(
        _request(f"{FLIGHT_SEARCHES_PATH}/{job_id}/challenges/{challenge_id}/respond", method="POST", payload={"value": value.strip()}, authenticated=True),
        lambda result: isinstance(result, dict) and isinstance(result.get("ok"), bool),
    )


@router.post("/flight-searches/{job_id}/cancel")
async def cancel_flight_search(job_id: str) -> dict[str, Any]:
    if not _valid_identifier(job_id):
        raise HTTPException(status_code=400, detail={"error": "invalid_flight_identifier"})
    return await _json_call(
        _request(f"{FLIGHT_SEARCHES_PATH}/{job_id}/cancel", method="POST", payload={}, authenticated=True),
        lambda result: isinstance(result, dict) and isinstance(result.get("ok"), bool),
    )
