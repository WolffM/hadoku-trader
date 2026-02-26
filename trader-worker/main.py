"""
Hadoku Trader Worker - Local PM2 service for trade execution.

This service runs on your local machine and exposes an HTTP API
that hadoku-site can call via a cloudflared tunnel to execute trades.
"""

import os
import sys
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel
from dotenv import load_dotenv

# Add fidelity-api to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "fidelity-api"))

from fidelity import FidelityClient

load_dotenv()
load_dotenv("../.env")


# =============================================================================
# Configuration
# =============================================================================

FIDELITY_USERNAME = os.environ.get("FIDELITY_USERNAME")
FIDELITY_PASSWORD = os.environ.get("FIDELITY_PASSWORD")
FIDELITY_TOTP_SECRET = os.environ.get("FIDELITY_TOTP_SECRET")
API_SECRET = os.environ.get("FIDELITY_API_KEY", "dev-secret")
DEFAULT_ACCOUNT = os.environ.get("FIDELITY_DEFAULT_ACCOUNT")


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
# Fidelity Client Management
# =============================================================================

_client: Optional[FidelityClient] = None
_authenticated: bool = False


def get_client() -> FidelityClient:
    """Get or create the Fidelity client."""
    global _client, _authenticated

    if _client is None:
        _client = FidelityClient(
            headless=True,
            save_state=True,
            profile_path=os.path.dirname(__file__),
            debug=False,
        )

    return _client


def ensure_authenticated() -> bool:
    """Ensure the client is authenticated."""
    global _authenticated

    if _authenticated:
        return True

    if not all([FIDELITY_USERNAME, FIDELITY_PASSWORD, FIDELITY_TOTP_SECRET]):
        return False

    client = get_client()
    step1, step2 = client.login(
        username=FIDELITY_USERNAME,
        password=FIDELITY_PASSWORD,
        totp_secret=FIDELITY_TOTP_SECRET,
        save_device=False,
    )

    _authenticated = step1 and step2
    return _authenticated


# =============================================================================
# Auth Dependency
# =============================================================================

async def verify_api_key(x_api_key: str = Header(...)):
    """Verify the API key from the request header."""
    if x_api_key != API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key


# =============================================================================
# Lifespan
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app lifecycle."""
    # Startup: try to authenticate
    print("Starting trader-worker...")
    if all([FIDELITY_USERNAME, FIDELITY_PASSWORD, FIDELITY_TOTP_SECRET]):
        print("Credentials found, attempting authentication...")
        if ensure_authenticated():
            print("Successfully authenticated with Fidelity")
        else:
            print("Warning: Authentication failed")
    else:
        print("Warning: Missing Fidelity credentials in environment")

    yield

    # Shutdown: close browser
    global _client
    if _client:
        print("Closing Fidelity browser...")
        _client.close_browser()
        _client = None


# =============================================================================
# App
# =============================================================================

app = FastAPI(
    title="Hadoku Trader Worker",
    description="Local trade execution service for hadoku-trader",
    version="1.0.0",
    lifespan=lifespan,
)


# =============================================================================
# Endpoints
# =============================================================================

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    global _authenticated

    accounts = None
    if _authenticated:
        try:
            client = get_client()
            account_info = client.getAccountInfo()
            accounts = list(account_info.keys()) if account_info else None
        except Exception:
            pass

    return HealthResponse(
        status="ok",
        authenticated=_authenticated,
        accounts=accounts,
    )


@app.post("/execute-trade", response_model=TradeResponse, dependencies=[Depends(verify_api_key)])
async def execute_trade(request: TradeRequest):
    """
    Execute a trade on Fidelity.

    This endpoint is called by hadoku-site via the cloudflared tunnel.
    """
    global _authenticated

    # Ensure authenticated
    if not _authenticated:
        if not ensure_authenticated():
            raise HTTPException(
                status_code=503,
                detail="Not authenticated with Fidelity. Check credentials.",
            )

    # Determine account
    account = request.account or DEFAULT_ACCOUNT
    if not account:
        raise HTTPException(
            status_code=400,
            detail="No account specified and no default account configured",
        )

    try:
        client = get_client()

        # Execute transaction
        success, error_message = client.transaction(
            stock=request.ticker.upper(),
            quantity=request.quantity,
            action=request.action.lower(),
            account=account,
            dry=request.dry_run,
            limit_price=request.limit_price,
        )

        if success:
            action_word = "previewed" if request.dry_run else "executed"
            return TradeResponse(
                success=True,
                message=f"Trade {action_word} successfully",
                details={
                    "ticker": request.ticker.upper(),
                    "action": request.action,
                    "quantity": request.quantity,
                    "account": account,
                    "dry_run": request.dry_run,
                },
            )
        else:
            return TradeResponse(
                success=False,
                message=error_message or "Trade failed",
                details={
                    "ticker": request.ticker.upper(),
                    "action": request.action,
                    "quantity": request.quantity,
                    "account": account,
                },
            )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Trade execution error: {str(e)}",
        )


@app.get("/accounts", dependencies=[Depends(verify_api_key)])
async def get_accounts():
    """Get all Fidelity accounts and their balances."""
    global _authenticated

    if not _authenticated:
        if not ensure_authenticated():
            raise HTTPException(status_code=503, detail="Not authenticated")

    try:
        client = get_client()
        account_info = client.getAccountInfo()

        if not account_info:
            return {"accounts": []}

        accounts = []
        for acc_num, data in account_info.items():
            accounts.append(AccountInfo(
                account_number=acc_num,
                nickname=data.get("nickname"),
                balance=data.get("balance", 0),
                positions=data.get("stocks", []),
            ))

        return {"accounts": accounts}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/refresh-session", dependencies=[Depends(verify_api_key)])
async def refresh_session():
    """Force re-authentication with Fidelity."""
    global _client, _authenticated

    # Close existing client
    if _client:
        _client.close_browser()
        _client = None

    _authenticated = False

    # Re-authenticate
    if ensure_authenticated():
        return {"success": True, "message": "Session refreshed"}
    else:
        raise HTTPException(status_code=503, detail="Failed to authenticate")


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("TRADER_WORKER_PORT", 8765))
    uvicorn.run(app, host="127.0.0.1", port=port)
