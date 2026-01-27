"""
Async trader service that wraps FidelityClientAsync for API use.
"""

import os
from typing import Optional
from dataclasses import dataclass, field

from fidelity.async_client import FidelityClientAsync


@dataclass
class TraderConfig:
    """Configuration for the trader service."""

    username: str = field(default_factory=lambda: os.environ.get("FIDELITY_USERNAME", ""))
    password: str = field(default_factory=lambda: os.environ.get("FIDELITY_PASSWORD", ""))
    totp_secret: str = field(default_factory=lambda: os.environ.get("FIDELITY_TOTP_SECRET", ""))
    api_secret: str = field(default_factory=lambda: os.environ.get("TRADER_API_SECRET", "dev-secret"))
    default_account: Optional[str] = field(
        default_factory=lambda: os.environ.get("FIDELITY_DEFAULT_ACCOUNT")
    )
    headless: bool = False  # Headed mode by default - headless unreliable with Fidelity
    profile_path: str = "."

    @property
    def has_credentials(self) -> bool:
        return all([self.username, self.password, self.totp_secret])


class TraderService:
    """
    Async service layer for Fidelity trading operations.

    Usage:
        service = TraderService()
        await service.initialize()
        await service.authenticate()
        result = await service.execute_trade("AAPL", "buy", 10)
        await service.close()
    """

    def __init__(self, config: Optional[TraderConfig] = None):
        self.config = config or TraderConfig()
        self._client: Optional[FidelityClientAsync] = None
        self._authenticated: bool = False
        self._initialized: bool = False

    async def initialize(self) -> None:
        """Initialize the async client. Must be called before other methods."""
        if self._initialized:
            return

        self._client = FidelityClientAsync(
            headless=self.config.headless,
            save_state=True,
            profile_path=self.config.profile_path,
            debug=False,
        )
        await self._client.initialize()
        self._initialized = True

    @property
    def client(self) -> FidelityClientAsync:
        """Get the Fidelity client."""
        if self._client is None:
            raise RuntimeError("Service not initialized. Call await service.initialize() first.")
        return self._client

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    async def authenticate(self) -> bool:
        """Authenticate with Fidelity. Returns True on success."""
        if self._authenticated:
            return True

        if not self._initialized:
            await self.initialize()

        if not self.config.has_credentials:
            return False

        step1, step2 = await self.client.login(
            username=self.config.username,
            password=self.config.password,
            totp_secret=self.config.totp_secret,
            save_device=False,
        )

        self._authenticated = step1 and step2
        return self._authenticated

    async def execute_trade(
        self,
        ticker: str,
        action: str,
        quantity: float,
        account: Optional[str] = None,
        dry_run: bool = True,
        limit_price: Optional[float] = None,
    ) -> tuple[bool, str, Optional[dict]]:
        """
        Execute a trade.

        Returns:
            Tuple of (success, message, details)
        """
        if not self._authenticated:
            if not await self.authenticate():
                return False, "Not authenticated with Fidelity", None

        target_account = account or self.config.default_account
        if not target_account:
            return False, "No account specified", None

        try:
            success, error_message, alert_code = await self.client.transaction(
                stock=ticker.upper(),
                quantity=quantity,
                action=action.lower(),
                account=target_account,
                dry=dry_run,
                limit_price=limit_price,
            )

            if success:
                action_word = "previewed" if dry_run else "executed"
                return True, f"Trade {action_word} successfully", {
                    "ticker": ticker.upper(),
                    "action": action,
                    "quantity": quantity,
                    "account": target_account,
                    "dry_run": dry_run,
                    "alert": alert_code,
                }
            else:
                return False, error_message or "Trade failed", {
                    "alert": alert_code,
                    "ticker": ticker.upper(),
                    "action": action,
                }

        except Exception as e:
            return False, f"Trade execution error: {str(e)}", {
                "alert": "UNKNOWN",
            }

    async def get_accounts(self) -> list[dict]:
        """Get all accounts and their positions."""
        if not self._authenticated:
            if not await self.authenticate():
                return []

        try:
            account_info = await self.client.get_account_info()
            if not account_info:
                return []

            accounts = []
            for acc_num, account in account_info.items():
                accounts.append({
                    "account_number": acc_num,
                    "nickname": getattr(account, 'nickname', None),
                    "balance": account.balance,
                    "positions": [
                        {
                            "ticker": s.ticker,
                            "quantity": s.quantity,
                            "last_price": s.last_price,
                            "value": s.value,
                        }
                        for s in account.stocks
                    ],
                })
            return accounts

        except Exception:
            return []

    async def refresh(self) -> bool:
        """Force re-authentication."""
        await self.close()
        await self.initialize()
        return await self.authenticate()

    async def close(self) -> None:
        """Close the browser and clean up."""
        if self._client:
            await self._client.close()
            self._client = None
        self._authenticated = False
        self._initialized = False
