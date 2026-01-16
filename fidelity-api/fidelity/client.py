"""
Main client module for Fidelity API.

Provides a unified interface to all Fidelity operations.
"""

from typing import Optional, Literal

from .browser import FidelityBrowser
from .auth import FidelityAuth
from .accounts import FidelityAccounts
from .trading import FidelityTrading
from .transfers import FidelityTransfers
from .management import FidelityManagement
from .statements import FidelityStatements
from .models import LoginResult, OrderResult


class FidelityClient:
    """
    Main Fidelity API client.

    Provides a unified interface for all Fidelity operations including
    authentication, account management, trading, and more.

    Example:
        ```python
        from fidelity import FidelityClient

        with FidelityClient(headless=True) as client:
            client.login("username", "password", "totp_secret")
            accounts = client.get_account_info()
            print(accounts)
        ```
    """

    def __init__(
        self,
        headless: bool = True,
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
        source_account: Optional[str] = None,
    ) -> None:
        """
        Initialize the Fidelity client.

        Args:
            headless: Run browser in headless mode. Default True.
            save_state: Save session cookies. Default True.
            profile_path: Directory for session files. Default current dir.
            title: Optional title for unique session files.
            debug: Enable debug tracing. Default False.
            source_account: Default source account for transfers.
        """
        self.source_account = source_account

        # Initialize browser
        self._browser = FidelityBrowser(
            headless=headless,
            save_state=save_state,
            profile_path=profile_path,
            title=title,
            debug=debug,
        )

        # Initialize service modules
        self._auth = FidelityAuth(self._browser)
        self._accounts = FidelityAccounts(self._browser)
        self._trading = FidelityTrading(self._browser)
        self._transfers = FidelityTransfers(self._browser)
        self._management = FidelityManagement(self._browser)
        self._statements = FidelityStatements(self._browser, title)

    # =========================================================================
    # Properties
    # =========================================================================

    @property
    def browser(self) -> FidelityBrowser:
        """Access the underlying browser instance."""
        return self._browser

    @property
    def page(self):
        """Access the Playwright page object."""
        return self._browser.page

    @property
    def account_dict(self) -> dict:
        """Get accounts as dictionary (backward compatibility)."""
        return {num: acc.to_dict() for num, acc in self._accounts.accounts.items()}

    @property
    def new_account_number(self) -> Optional[str]:
        """Get the most recently opened account number."""
        return self._management.new_account_number

    # =========================================================================
    # Authentication
    # =========================================================================

    def login(
        self,
        username: str,
        password: str,
        totp_secret: Optional[str] = None,
        save_device: bool = False,
    ) -> tuple[bool, bool]:
        """
        Log into Fidelity.

        Args:
            username: Fidelity username.
            password: Fidelity password.
            totp_secret: TOTP secret for 2FA (optional).
            save_device: Remember device for future logins.

        Returns:
            Tuple of (step1_success, fully_logged_in).
            If (True, False), call login_2FA with SMS code.
        """
        result = self._auth.login(username, password, totp_secret, save_device)
        return (result.step1_success, result.fully_logged_in)

    def login_2FA(self, code: str, save_device: bool = True) -> bool:
        """
        Complete 2FA login with SMS code.

        Args:
            code: SMS verification code.
            save_device: Remember device.

        Returns:
            True if successful.
        """
        return self._auth.login_2fa(code, save_device)

    # =========================================================================
    # Account Information
    # =========================================================================

    def getAccountInfo(self) -> dict:
        """
        Get account information from positions CSV.

        Returns:
            Dictionary of accounts with balances and holdings.
        """
        return self._accounts.get_account_info()

    def get_list_of_accounts(
        self,
        set_flag: bool = True,
        get_withdrawal_bal: bool = False,
    ) -> dict:
        """
        Get list of all accounts from transfers page.

        Args:
            set_flag: Update internal account dict. Default True.
            get_withdrawal_bal: Fetch withdrawal balances.

        Returns:
            Dictionary of accounts.
        """
        return self._accounts.get_account_list(get_withdrawal_balance=get_withdrawal_bal)

    def get_stocks_in_account(self, account_number: str) -> dict:
        """
        Get stocks in a specific account.

        Args:
            account_number: Account to query.

        Returns:
            Dict mapping ticker to quantity.
        """
        return self._accounts.get_stocks_in_account(account_number)

    def summary_holdings(self) -> dict:
        """
        Get aggregated holdings across all accounts.

        Returns:
            Dict of tickers with quantities and values.
        """
        return self._accounts.summary_holdings()

    # =========================================================================
    # Trading
    # =========================================================================

    def transaction(
        self,
        stock: str,
        quantity: float,
        action: str,
        account: str,
        dry: bool = True,
        limit_price: Optional[float] = None,
    ) -> tuple[bool, Optional[str]]:
        """
        Execute a buy or sell transaction.

        Args:
            stock: Ticker symbol.
            quantity: Number of shares.
            action: "buy" or "sell".
            account: Account number.
            dry: Preview only, no execution. Default True.
            limit_price: Optional limit price.

        Returns:
            Tuple of (success, error_message).
        """
        result = self._trading.transaction(
            stock=stock,
            quantity=quantity,
            action=action,
            account=account,
            dry=dry,
            limit_price=limit_price,
        )
        return (result.success, result.error_message)

    # =========================================================================
    # Transfers
    # =========================================================================

    def transfer_acc_to_acc(
        self,
        source_account: str,
        destination_account: str,
        transfer_amount: float,
    ) -> bool:
        """
        Transfer funds between accounts.

        Args:
            source_account: Account to transfer from.
            destination_account: Account to transfer to.
            transfer_amount: Amount to transfer.

        Returns:
            True if successful.
        """
        return self._transfers.transfer(
            source_account=source_account,
            destination_account=destination_account,
            amount=transfer_amount,
        )

    # =========================================================================
    # Account Management
    # =========================================================================

    def open_account(self, type: Literal["roth", "brokerage"]) -> bool:
        """
        Open a new account.

        Args:
            type: "roth" or "brokerage".

        Returns:
            True if successful. New number in new_account_number.
        """
        return self._management.open_account(type)

    def enable_pennystock_trading(self, account: str) -> bool:
        """
        Enable penny stock trading for an account.

        Args:
            account: Account number.

        Returns:
            True if successful or already enabled.
        """
        return self._management.enable_penny_stocks(account)

    def nickname_account(self, account_number: str, nickname: str) -> bool:
        """
        Set account nickname.

        Args:
            account_number: Account to nickname.
            nickname: New nickname.

        Returns:
            True if successful.
        """
        return self._management.nickname_account(account_number, nickname)

    # =========================================================================
    # Statements
    # =========================================================================

    def download_statements(self, date: str) -> Optional[list[str]]:
        """
        Download statements for a given month.

        Args:
            date: Date in "YYYY/MM" format.

        Returns:
            List of downloaded file paths, or None.
        """
        return self._statements.download_statements(date)

    # =========================================================================
    # Browser Management
    # =========================================================================

    def save_storage_state(self) -> None:
        """Save session cookies to file."""
        self._browser.save_storage_state()

    def close_browser(self) -> None:
        """Close the browser and clean up."""
        self._browser.close()

    def wait_for_loading_sign(self, timeout: int = 30000) -> None:
        """Wait for loading indicators to disappear."""
        self._browser.wait_for_loading(timeout)

    # =========================================================================
    # Backward Compatibility Methods
    # =========================================================================

    def getDriver(self) -> None:
        """Backward compatibility - browser is initialized in __init__."""
        pass

    def set_account_dict(self, *args, **kwargs) -> bool:
        """Backward compatibility - use Account dataclass instead."""
        return False

    def add_stock_to_account_dict(self, *args, **kwargs) -> bool:
        """Backward compatibility - use Account dataclass instead."""
        return False

    def add_withdrawal_bal_to_account_dict(self, *args, **kwargs) -> bool:
        """Backward compatibility - use Account dataclass instead."""
        return False

    def add_nickname_to_account_dict(self, *args, **kwargs) -> bool:
        """Backward compatibility - use Account dataclass instead."""
        return False

    # =========================================================================
    # Context Manager
    # =========================================================================

    def __enter__(self) -> "FidelityClient":
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit."""
        self.close_browser()


# Backward compatibility alias
FidelityAutomation = FidelityClient
