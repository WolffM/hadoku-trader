"""
Trader service that wraps FidelityClient for API use.
"""

import os
from typing import Optional
from dataclasses import dataclass, field

from fidelity import FidelityClient


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
    headless: bool = True
    profile_path: str = "."

    @property
    def has_credentials(self) -> bool:
        return all([self.username, self.password, self.totp_secret])


class TraderService:
    """
    Service layer for Fidelity trading operations.

    Usage:
        service = TraderService()
        service.authenticate()
        result = service.execute_trade("AAPL", "buy", 10)
    """

    def __init__(self, config: Optional[TraderConfig] = None):
        self.config = config or TraderConfig()
        self._client: Optional[FidelityClient] = None
        self._authenticated: bool = False

    @property
    def client(self) -> FidelityClient:
        """Get or create the Fidelity client."""
        if self._client is None:
            self._client = FidelityClient(
                headless=self.config.headless,
                save_state=True,
                profile_path=self.config.profile_path,
                debug=False,
            )
        return self._client

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    def authenticate(self) -> bool:
        """Authenticate with Fidelity. Returns True on success."""
        if self._authenticated:
            return True

        if not self.config.has_credentials:
            return False

        step1, step2 = self.client.login(
            username=self.config.username,
            password=self.config.password,
            totp_secret=self.config.totp_secret,
            save_device=False,
        )

        self._authenticated = step1 and step2
        return self._authenticated

    def execute_trade(
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
            if not self.authenticate():
                return False, "Not authenticated with Fidelity", None

        target_account = account or self.config.default_account
        if not target_account:
            return False, "No account specified", None

        try:
            success, error_message = self.client.transaction(
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
                }
            else:
                return False, error_message or "Trade failed", None

        except Exception as e:
            return False, f"Trade execution error: {str(e)}", None

    def get_accounts(self) -> list[dict]:
        """Get all accounts and their positions."""
        if not self._authenticated:
            if not self.authenticate():
                return []

        try:
            account_info = self.client.getAccountInfo()
            if not account_info:
                return []

            accounts = []
            for acc_num, data in account_info.items():
                accounts.append({
                    "account_number": acc_num,
                    "nickname": data.get("nickname"),
                    "balance": data.get("balance", 0),
                    "positions": data.get("stocks", []),
                })
            return accounts

        except Exception:
            return []

    def refresh(self) -> bool:
        """Force re-authentication."""
        self.close()
        return self.authenticate()

    def close(self):
        """Close the browser and clean up."""
        if self._client:
            self._client.close_browser()
            self._client = None
        self._authenticated = False
