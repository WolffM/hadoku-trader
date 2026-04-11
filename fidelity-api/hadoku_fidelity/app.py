"""
FastAPI application factory for the trader service.

Usage in hadoku-site:
    from hadoku_fidelity import create_app
    app = create_app()
"""

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel

from .service import TraderService, TraderConfig


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
        response_model=TradeResponse,
        dependencies=[Depends(verify_api_key)],
    )
    async def execute_trade(request: TradeRequest):
        """Execute a trade on Fidelity. Triggers browser + auth if needed."""
        await _ensure_authenticated()

        success, message, details = await service.execute_trade(
            ticker=request.ticker,
            action=request.action,
            quantity=request.quantity,
            account=request.account,
            dry_run=request.dry_run,
            limit_price=request.limit_price,
        )

        if not success and "Not authenticated" in message:
            raise HTTPException(status_code=503, detail=message)

        alert = details.get("alert", "UNKNOWN") if details else "UNKNOWN"

        return TradeResponse(
            success=success,
            message=message,
            alert=alert,
            details=details,
        )

    @app.get("/accounts", dependencies=[Depends(verify_api_key)])
    async def get_accounts():
        """Get all Fidelity accounts. Triggers browser + auth if needed."""
        await _ensure_authenticated()
        accounts = await service.get_accounts()
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
