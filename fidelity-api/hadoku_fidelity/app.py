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
    positions: list[dict]


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
        """Get all Fidelity accounts. Triggers browser + auth if needed."""
        await _ensure_authenticated()
        try:
            accounts = await service.get_accounts()
        except RuntimeError as e:
            # service.get_accounts() now raises on failure instead of silently
            # returning []. Surface the real error so callers can act on it
            # (previously every failure looked like "no accounts", which hid
            # every browser/auth/scrape bug behind a 200 OK).
            raise HTTPException(status_code=503, detail=f"get_accounts failed: {e}")
        return {"accounts": [AccountInfo(**a) for a in accounts]}

    @app.post("/refresh-session", dependencies=[Depends(verify_api_key)])
    async def refresh_session():
        """Force re-authentication."""
        try:
            if await service.refresh():
                return {"success": True, "message": "Session refreshed"}
            else:
                raise HTTPException(status_code=503, detail="Failed to authenticate")
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=f"Browser init failed: {e}")

    return app
