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
    # THE single account the auto-trader is allowed to touch. /accounts is
    # filtered to this account and /execute-trade rejects any request for a
    # different one. Set via FIDELITY_TRADING_ACCOUNT (the preferred name),
    # falling back to FIDELITY_DEFAULT_ACCOUNT for backwards compat with any
    # remaining shell env pinning the old name.
    trading_account: Optional[str] = field(
        default_factory=lambda: (
            os.environ.get("FIDELITY_TRADING_ACCOUNT")
            or os.environ.get("FIDELITY_DEFAULT_ACCOUNT")
        )
    )
    headless: bool = False  # Headed mode by default - headless unreliable with Fidelity
    # Browser storage state file (Patchright cookies + localStorage) is written
    # here. Using ~/.hadoku-fidelity/ instead of cwd so the file survives
    # package reinstalls / deploys, lives outside any git-tracked directory
    # (it holds session cookies, which are secrets), and is stable across
    # PM2 restarts even if the cwd moves for any reason.
    profile_path: str = field(
        default_factory=lambda: os.environ.get(
            "FIDELITY_PROFILE_PATH",
            os.path.expanduser("~/.hadoku-fidelity"),
        )
    )

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

        # Make sure the storage directory exists before Patchright tries to
        # read/write the cookies JSON from it.
        try:
            os.makedirs(self.config.profile_path, exist_ok=True)
        except Exception as e:
            print(f"[INIT] warning: could not create profile_path {self.config.profile_path}: {e}")

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

        # save_device=True tells Fidelity to "Remember this device" — it
        # writes a long-lived trust cookie so subsequent logins skip the
        # 2FA prompt entirely. The first login after a new storage-state
        # file still needs a TOTP, but from then on re-auth is just
        # username/password. Combined with the persistent profile_path,
        # this eliminates the headed 2FA popup on every PM2 restart.
        step1, step2 = await self.client.login(
            username=self.config.username,
            password=self.config.password,
            totp_secret=self.config.totp_secret,
            save_device=True,
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

        # Lock the trader to the one account we're allowed to touch.
        # If the caller didn't specify, we use the configured trading_account.
        # If the caller specified something DIFFERENT, refuse — nothing should
        # be dispatching trades against any other account on this Fidelity
        # login (Individual, 401K, HSA, etc).
        if not self.config.trading_account:
            return (
                False,
                "No trading_account configured — set FIDELITY_TRADING_ACCOUNT",
                None,
            )
        target_account = account or self.config.trading_account
        if target_account != self.config.trading_account:
            return (
                False,
                (
                    f"Refusing to trade on account {target_account} — "
                    f"this service is locked to {self.config.trading_account}"
                ),
                {"alert": "ACCOUNT_MISMATCH"},
            )

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
        Return the configured trading account with its positions and cash.

        Although the underlying scrape walks every account on the Fidelity
        login (Individual, TOD, 401K, HSA, etc.), this method filters the
        result down to just `trading_account` — the one account we're
        allowed to touch. Returning every account would be both noisy and
        a safety hazard (a caller could end up asking for trades on the
        wrong one).

        Raises:
          RuntimeError on auth failure, scrape failure, missing
          trading_account config, or if the configured trading account
          isn't present in the scrape result (indicates either a typo in
          config or a Fidelity UI change).
        """
        if not self._authenticated:
            if not await self.authenticate():
                raise RuntimeError("Fidelity authentication failed")

        if not self.config.trading_account:
            raise RuntimeError(
                "No trading_account configured — set FIDELITY_TRADING_ACCOUNT"
            )

        # Health gate: refresh if the page died since last op.
        await self._ensure_page_alive()

        async with self._browser_lock:
            account_info = await self.client.get_account_info()

        if not account_info:
            raise RuntimeError(
                "get_account_info returned empty — browser scrape likely failed"
            )

        if self.config.trading_account not in account_info:
            scraped = list(account_info.keys())
            raise RuntimeError(
                f"Trading account {self.config.trading_account} not found in "
                f"scrape — got {scraped}. Either the config is wrong or the "
                f"Fidelity positions page is hiding the account."
            )

        # Filter to the single allowed account.
        account_info = {
            self.config.trading_account: account_info[self.config.trading_account]
        }

        accounts = []
        for acc_num, account in account_info.items():
            # Cash rows are surfaced as regular positions with is_cash=True so
            # the caller can distinguish them and also compute a cash total.
            cash_total = sum(
                (s.value or 0.0) for s in account.stocks if getattr(s, "is_cash", False)
            )
            accounts.append({
                "account_number": acc_num,
                "nickname": getattr(account, 'nickname', None),
                "balance": account.balance,
                "cash": cash_total,
                "positions": [
                    {
                        "ticker": s.ticker,
                        "quantity": s.quantity,
                        "last_price": s.last_price,
                        "value": s.value,
                        "cost_basis": getattr(s, "cost_basis", None),
                        "is_cash": getattr(s, "is_cash", False),
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
