"""
FastAPI application factory for the trader service.

Usage in hadoku-site:
    from hadoku_fidelity import create_app
    app = create_app()
"""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .service import TraderService, TraderConfig


# Heartbeat interval for streaming trade responses. Must be shorter than
# Cloudflare's edge idle-stream timeout (60s on Free plan). 20s gives us
# three heartbeat windows per CF kill window — plenty of slack.
_HEARTBEAT_INTERVAL_SECONDS = 20


# =============================================================================
# Models
# =============================================================================


class TradeRequest(BaseModel):
    """Request to execute a trade."""

    ticker: str
    action: str  # "buy" or "sell"
    quantity: float
    account: Optional[str] = None
    dry_run: bool = True
    limit_price: Optional[float] = None


class TradeResponse(BaseModel):
    """Response from trade execution."""

    success: bool
    message: str
    alert: str = "UNKNOWN"  # TradeAlert code (SUCCESS, NO_POSITION, etc.)
    order_id: Optional[str] = None
    details: Optional[dict] = None


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    authenticated: bool
    accounts: Optional[list[str]] = None


class AccountInfo(BaseModel):
    """Account information."""

    account_number: str
    nickname: Optional[str]
    balance: float
    cash: float = 0.0
    positions: list[dict]


class DebugNavRequest(BaseModel):
    """Payload for POST /debug/nav — navigate current browser to a URL and dump state."""

    url: str
    wait_ms: int = 3000  # fixed post-nav sleep before capturing
    html_limit: int = 500_000  # cap returned HTML to avoid massive payloads


class DebugEvalRequest(BaseModel):
    """Payload for POST /debug/eval — run arbitrary JS on the current page."""

    script: str
    url: Optional[str] = None  # if provided, navigate first
    wait_ms: int = 1000


# =============================================================================
# App Factory
# =============================================================================


def create_app(config: Optional[TraderConfig] = None) -> FastAPI:
    """
    Create a FastAPI application for the trader service.

    Browser and Fidelity auth are fully lazy — nothing launches until
    a trade or account request actually needs it. This keeps PM2
    restarts instant (no headed Chrome popping up on every restart).
    """
    service_config = config or TraderConfig()
    service = TraderService(service_config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Server starts immediately. Browser launches on first real request."""
        print("Starting hadoku-fidelity trader service (lazy auth)...")
        yield
        print("Shutting down trader service...")
        await service.close()

    app = FastAPI(
        title="Hadoku Trader Service",
        description="Fidelity trade execution service for hadoku",
        version="1.2.0",
        lifespan=lifespan,
    )

    app.state.service = service
    app.state.config = service_config

    # =============================================================================
    # Helpers
    # =============================================================================

    async def _ensure_browser():
        """Lazy-init browser on first request that needs it."""
        if not service._initialized:
            print("[LAZY] Initializing browser on first request...")
            try:
                await service.initialize()
            except Exception as e:
                raise HTTPException(status_code=503, detail=f"Browser not ready: {e}")

    async def _ensure_authenticated():
        """Lazy-init browser + authenticate on first request that needs it."""
        await _ensure_browser()
        # Detect a dead page before attempting auth — if the page closed after
        # initialize() (e.g. TargetClosedError from a prior op), _ensure_page_alive
        # calls refresh() which tears down and re-launches the browser so the
        # subsequent authenticate() has a live page to work with.
        await service._ensure_page_alive()
        if not service.authenticated:
            print("[LAZY] Authenticating on first request...")
            if not await service.authenticate():
                raise HTTPException(status_code=503, detail="Fidelity authentication failed")

    # =============================================================================
    # Auth Dependency
    # =============================================================================

    async def verify_api_key(x_api_key: str = Header(...)):
        """Verify the API key from the request header."""
        if x_api_key != service_config.api_secret:
            raise HTTPException(status_code=401, detail="Invalid API key")
        return x_api_key

    # =============================================================================
    # Routes
    # =============================================================================

    @app.get("/health", response_model=HealthResponse)
    async def health_check():
        """Health check — always fast. Does NOT trigger browser/auth."""
        return HealthResponse(
            status="ok" if service._initialized else "idle",
            authenticated=service.authenticated,
            accounts=None,
        )

    @app.post(
        "/execute-trade",
        dependencies=[Depends(verify_api_key)],
    )
    async def execute_trade(request: TradeRequest):
        """
        Execute a trade on Fidelity. Triggers browser + auth if needed.

        Returns an NDJSON stream rather than a single JSON body so that
        Cloudflare's edge idle-stream timeout (60s on Free plan) doesn't
        kill the connection during the 40-90s Patchright automation.

        Response body format (one JSON object per line):
            {"event": "heartbeat"}          (emitted every ~20s while working)
            ...
            {"event": "result", "data": {TradeResponse fields}}   (final line)

        Callers should read the entire body and parse the last non-heartbeat
        line as the real result. Failure inside the stream is also delivered
        as a result event with success=False.
        """
        await _ensure_authenticated()

        async def generate():
            trade_task = asyncio.create_task(
                service.execute_trade(
                    ticker=request.ticker,
                    action=request.action,
                    quantity=request.quantity,
                    account=request.account,
                    dry_run=request.dry_run,
                    limit_price=request.limit_price,
                )
            )

            # Emit a heartbeat immediately so the edge sees first-byte in <1s
            # (the kill is an idle timer, not a total-time cap).
            yield b'{"event":"heartbeat"}\n'

            while not trade_task.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(trade_task),
                        timeout=_HEARTBEAT_INTERVAL_SECONDS,
                    )
                except asyncio.TimeoutError:
                    yield b'{"event":"heartbeat"}\n'

            try:
                success, message, details = trade_task.result()
            except Exception as e:
                # Any unhandled exception inside service.execute_trade becomes
                # a failed-result event rather than a 500 stack trace, so the
                # caller always gets a structured outcome.
                result_payload = {
                    "success": False,
                    "message": f"Internal error: {e!r}",
                    "alert": "UNKNOWN",
                    "order_id": None,
                    "details": None,
                }
                yield (
                    json.dumps({"event": "result", "data": result_payload})
                    .encode()
                    + b"\n"
                )
                return

            alert = details.get("alert", "UNKNOWN") if details else "UNKNOWN"
            result_payload = {
                "success": success,
                "message": message,
                "alert": alert,
                "order_id": None,
                "details": details,
            }
            yield (
                json.dumps({"event": "result", "data": result_payload}).encode()
                + b"\n"
            )

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    @app.get("/accounts", dependencies=[Depends(verify_api_key)])
    async def get_accounts():
        """
        Get all Fidelity accounts. Triggers browser + auth if needed.

        Returns an NDJSON stream for the same reason /execute-trade does:
        scraping the Fidelity positions page takes 60-120s of browser
        automation, which exceeds Cloudflare's 60s edge idle-stream timeout
        on a plain JSON response. Heartbeats keep the connection alive.

        Response format:
            {"event":"heartbeat"}          (every ~20s while working)
            ...
            {"event":"result","data":{"accounts":[...]}}     (final line)
          OR
            {"event":"result","data":{"error":"..."}}        (final line on error)
        """
        await _ensure_authenticated()

        async def generate():
            accounts_task = asyncio.create_task(service.get_accounts())

            yield b'{"event":"heartbeat"}\n'

            while not accounts_task.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(accounts_task),
                        timeout=_HEARTBEAT_INTERVAL_SECONDS,
                    )
                except asyncio.TimeoutError:
                    yield b'{"event":"heartbeat"}\n'

            try:
                raw_accounts = accounts_task.result()
            except Exception as e:
                yield (
                    json.dumps(
                        {"event": "result", "data": {"error": f"get_accounts failed: {e!r}"}}
                    ).encode()
                    + b"\n"
                )
                return

            # Validate each row through AccountInfo so schema drift surfaces
            # as an exception in this line rather than silently mis-shaped JSON.
            try:
                payload = {"accounts": [AccountInfo(**a).model_dump() for a in raw_accounts]}
            except Exception as e:
                yield (
                    json.dumps(
                        {
                            "event": "result",
                            "data": {"error": f"AccountInfo validation failed: {e!r}"},
                        }
                    ).encode()
                    + b"\n"
                )
                return

            yield (
                json.dumps({"event": "result", "data": payload}).encode() + b"\n"
            )

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    @app.post("/refresh-session", dependencies=[Depends(verify_api_key)])
    async def refresh_session():
        """Force re-authentication. Alias: POST /login."""
        try:
            if await service.refresh():
                return {"success": True, "message": "Session refreshed"}
            else:
                raise HTTPException(status_code=503, detail="Failed to authenticate")
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=f"Browser init failed: {e}")

    @app.post("/login", dependencies=[Depends(verify_api_key)])
    async def login():
        """
        Explicit login. Launches the browser if needed, authenticates, and
        returns success when ready. If already authenticated, returns success
        without redoing the full browser restart. Use /refresh-session for
        a forced close+reinit+auth cycle.
        """
        try:
            await _ensure_browser()
            if service.authenticated:
                return {"success": True, "message": "Already authenticated"}
            if await service.authenticate():
                return {"success": True, "message": "Login successful"}
            raise HTTPException(status_code=503, detail="Login failed")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Login error: {e!r}")

    # =============================================================================
    # Debug endpoints — temporary diagnostic tools for fixing broken scrapers
    # =============================================================================
    # These let us navigate the live authenticated browser and dump DOM / run
    # JS to figure out why get_account_info() is hanging on the positions page.
    # API-keyed and lock-protected like the real endpoints. Remove once /accounts
    # is reliable.

    @app.post("/debug/nav", dependencies=[Depends(verify_api_key)])
    async def debug_nav(request: DebugNavRequest):
        """
        Navigate the current browser page to a URL and dump its state.

        Returns NDJSON stream ending in:
            {"event":"result","data":{"url":"...", "title":"...", "html":"..."}}

        The html field is truncated to request.html_limit characters so we
        don't produce massive streams. For targeted inspection use /debug/eval.
        """
        await _ensure_authenticated()

        async def generate():
            async def _do_nav():
                async with service._browser_lock:
                    page = service.client._browser.page
                    await page.goto(request.url, wait_until="domcontentloaded")
                    await page.wait_for_timeout(request.wait_ms)
                    final_url = page.url
                    try:
                        title = await page.title()
                    except Exception as e:
                        title = f"<title error: {e!r}>"
                    try:
                        html = await page.content()
                    except Exception as e:
                        html = f"<content error: {e!r}>"
                    return {
                        "url": final_url,
                        "title": title,
                        "html_length": len(html),
                        "html": html[: request.html_limit],
                        "truncated": len(html) > request.html_limit,
                    }

            task = asyncio.create_task(_do_nav())
            yield b'{"event":"heartbeat"}\n'
            while not task.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(task), timeout=_HEARTBEAT_INTERVAL_SECONDS
                    )
                except asyncio.TimeoutError:
                    yield b'{"event":"heartbeat"}\n'
                except Exception:
                    # Inner task raised non-timeout. The task is now done; let
                    # the loop exit and the result extractor below surface the
                    # exception as a result event instead of crashing the
                    # stream (which previously returned HTTP/2 INTERNAL_ERROR
                    # and the client only saw one heartbeat).
                    break
            try:
                data = task.result()
            except Exception as e:
                data = {"error": f"{e!r}"}
            yield (json.dumps({"event": "result", "data": data}).encode() + b"\n")

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    @app.post("/debug/eval", dependencies=[Depends(verify_api_key)])
    async def debug_eval(request: DebugEvalRequest):
        """
        Run arbitrary JavaScript against the current page and return the result.

        If request.url is provided, navigates there first. Use this to probe
        the DOM directly — much lighter than dumping full HTML.

        Example script: "return document.querySelectorAll('.posweb-row-account').length"

        Playwright's page.evaluate wraps the script in a function body, so
        the script should return a JSON-serializable value.
        """
        await _ensure_authenticated()

        async def generate():
            async def _do_eval():
                async with service._browser_lock:
                    page = service.client._browser.page
                    if request.url:
                        await page.goto(request.url, wait_until="domcontentloaded")
                        await page.wait_for_timeout(request.wait_ms)
                    result = await page.evaluate(request.script)
                    return {
                        "url": page.url,
                        "result": result,
                    }

            task = asyncio.create_task(_do_eval())
            yield b'{"event":"heartbeat"}\n'
            while not task.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(task), timeout=_HEARTBEAT_INTERVAL_SECONDS
                    )
                except asyncio.TimeoutError:
                    yield b'{"event":"heartbeat"}\n'
                except Exception:
                    # Inner task raised — break out and let the result
                    # extractor report it as a result event instead of
                    # crashing the NDJSON stream (previously returned HTTP/2
                    # INTERNAL_ERROR with the client only seeing one heartbeat).
                    break
            try:
                data = task.result()
            except Exception as e:
                data = {"error": f"{e!r}"}
            yield (json.dumps({"event": "result", "data": data}).encode() + b"\n")

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    return app
