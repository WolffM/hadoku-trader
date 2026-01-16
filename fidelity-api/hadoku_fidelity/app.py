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


def create_app(
    config: Optional[TraderConfig] = None,
    auto_authenticate: bool = True,
) -> FastAPI:
    """
    Create a FastAPI application for the trader service.

    Args:
        config: Optional TraderConfig. If not provided, loads from environment.
        auto_authenticate: Whether to authenticate on startup.

    Returns:
        FastAPI application ready to run with uvicorn.

    Usage:
        # In hadoku-site's PM2 service runner:
        from hadoku_fidelity import create_app
        app = create_app()

        # Then run with uvicorn:
        # uvicorn main:app --host 127.0.0.1 --port 8765
    """
    service_config = config or TraderConfig()
    service = TraderService(service_config)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Manage app lifecycle."""
        print("Starting hadoku-fidelity trader service...")

        # Initialize the async service
        await service.initialize()

        if auto_authenticate and service_config.has_credentials:
            print("Credentials found, attempting authentication...")
            if await service.authenticate():
                print("Successfully authenticated with Fidelity")
            else:
                print("Warning: Authentication failed")
        elif not service_config.has_credentials:
            print("Warning: Missing Fidelity credentials in environment")

        yield

        print("Shutting down trader service...")
        await service.close()

    app = FastAPI(
        title="Hadoku Trader Service",
        description="Fidelity trade execution service for hadoku",
        version="1.0.4",
        lifespan=lifespan,
    )

    # Store service in app state for access in routes
    app.state.service = service
    app.state.config = service_config

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
        """Health check endpoint."""
        accounts = None
        if service.authenticated:
            try:
                account_list = await service.get_accounts()
                accounts = [a["account_number"] for a in account_list]
            except Exception:
                pass

        return HealthResponse(
            status="ok",
            authenticated=service.authenticated,
            accounts=accounts,
        )

    @app.post(
        "/execute-trade",
        response_model=TradeResponse,
        dependencies=[Depends(verify_api_key)],
    )
    async def execute_trade(request: TradeRequest):
        """Execute a trade on Fidelity."""
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

        return TradeResponse(
            success=success,
            message=message,
            details=details,
        )

    @app.get("/accounts", dependencies=[Depends(verify_api_key)])
    async def get_accounts():
        """Get all Fidelity accounts and their balances."""
        if not service.authenticated:
            if not await service.authenticate():
                raise HTTPException(status_code=503, detail="Not authenticated")

        accounts = await service.get_accounts()
        return {"accounts": [AccountInfo(**a) for a in accounts]}

    @app.post("/refresh-session", dependencies=[Depends(verify_api_key)])
    async def refresh_session():
        """Force re-authentication with Fidelity."""
        if await service.refresh():
            return {"success": True, "message": "Session refreshed"}
        else:
            raise HTTPException(status_code=503, detail="Failed to authenticate")

    return app
