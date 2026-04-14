"""
Async trader service that wraps FidelityClientPatchright for API use.

Uses Patchright (patched Playwright) to avoid CDP detection that triggers
Fidelity's bot detection.
"""

import asyncio
import os
from typing import Optional
from dataclasses import dataclass, field

from fidelity.patchright_client import FidelityClientPatchright


@dataclass
class TraderConfig:
    """Configuration for the trader service."""

    username: str = field(default_factory=lambda: os.environ.get("FIDELITY_USERNAME", ""))
    password: str = field(default_factory=lambda: os.environ.get("FIDELITY_PASSWORD", ""))
    totp_secret: str = field(default_factory=lambda: os.environ.get("FIDELITY_TOTP_SECRET", ""))
    api_secret: str = field(default_factory=lambda: os.environ.get("FIDELITY_API_KEY", "dev-secret"))
    default_account: Optional[str] = field(
        default_factory=lambda: os.environ.get("FIDELITY_DEFAULT_ACCOUNT")
    )
    headless: bool = False  # Headed mode by default - headless unreliable with Fidelity
    profile_path: str = "."

    @property
    def has_credentials(self) -> bool:
        return all([self.username, self.password, self.totp_secret])


# Browser launch can fail transiently on Windows (Chrome process dies during
# startup, especially right after a PM2 restart kills the previous instance).
# Retry a few times with backoff before giving up.
_INIT_MAX_RETRIES = 3
_INIT_BASE_DELAY = 2.0  # seconds


class TraderService:
    """
    Async service layer for Fidelity trading operations.

    Uses Patchright (patched Playwright) to avoid CDP detection that
    triggers Fidelity's bot detection.

    Usage:
        service = TraderService()
        await service.initialize()
        await service.authenticate()
        result = await service.execute_trade("AAPL", "buy", 10)
        await service.close()
    """

    def __init__(self, config: Optional[TraderConfig] = None):
        self.config = config or TraderConfig()
        self._client: Optional[FidelityClientPatchright] = None
        self._authenticated: bool = False
        self._initialized: bool = False
        # Serializes all browser operations. The underlying Patchright client
        # has a single page/browser context, so concurrent execute_trade or
        # get_accounts calls would navigate on top of each other and corrupt
        # in-flight orders. Every caller waits its turn.
        self._browser_lock: asyncio.Lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize the Patchright client with retry on transient browser failures."""
        if self._initialized:
            return

        last_error: Optional[Exception] = None
        for attempt in range(_INIT_MAX_RETRIES):
            try:
                client = FidelityClientPatchright(
                    headless=self.config.headless,
                    save_state=True,
                    profile_path=self.config.profile_path,
                    debug=False,
                )
                await client.initialize()
                self._client = client
                self._initialized = True
                if attempt > 0:
                    print(f"[INIT] Browser launched on attempt {attempt + 1}")
                return
            except Exception as e:
                last_error = e
                # Clean up the failed client before retrying
                try:
                    await client.close()
                except Exception:
                    pass
                if attempt < _INIT_MAX_RETRIES - 1:
                    delay = _INIT_BASE_DELAY * (attempt + 1)
                    print(
                        f"[INIT] Browser launch failed (attempt {attempt + 1}/{_INIT_MAX_RETRIES}): "
                        f"{e!r} — retrying in {delay:.0f}s"
                    )
                    await asyncio.sleep(delay)

        raise RuntimeError(
            f"Browser failed to launch after {_INIT_MAX_RETRIES} attempts: {last_error!r}"
        )

    @property
    def client(self) -> FidelityClientPatchright:
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

    async def _ensure_page_alive(self) -> None:
        """
        Detect a dead Patchright page and auto-recover.

        Called before acquiring the browser lock for a new op. If the page
        reference is closed (TargetClosedError / RuntimeError from
        _verify_page_connection), force a full refresh so the queued caller
        doesn't inherit a poisoned browser from a prior failed trade.

        refresh() itself acquires the browser lock, so this must run OUTSIDE
        the lock to avoid deadlock.
        """
        if not self._initialized or self._client is None:
            return
        try:
            await self._client._verify_page_connection()
        except Exception as e:
            print(f"[SERVICE] Page dead before op ({e!r}), forcing refresh...")
            await self.refresh()

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

        # Health gate: if the page died in a prior op, refresh before queueing.
        await self._ensure_page_alive()

        try:
            async with self._browser_lock:
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
        """
        Get all accounts and their positions.

        Raises RuntimeError on failure so callers can distinguish a genuinely
        empty account list from a broken browser/auth state. Previously this
        silently returned [] on any exception, which hid every failure behind
        a 200 OK empty response and made verification impossible.
        """
        if not self._authenticated:
            if not await self.authenticate():
                raise RuntimeError("Fidelity authentication failed")

        # Health gate: refresh if the page died since last op.
        await self._ensure_page_alive()

        async with self._browser_lock:
            account_info = await self.client.get_account_info()

        if not account_info:
            raise RuntimeError(
                "get_account_info returned empty — browser scrape likely failed"
            )

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

    async def refresh(self) -> bool:
        """Force re-authentication."""
        async with self._browser_lock:
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
