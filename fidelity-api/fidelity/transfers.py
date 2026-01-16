"""
Transfer module for Fidelity API.

Handles account-to-account transfers.
"""

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors
from .exceptions import InsufficientFundsError, AccountNotFoundError


class FidelityTransfers:
    """Handles Fidelity account transfers."""

    def __init__(self, browser: FidelityBrowser) -> None:
        """
        Initialize transfers handler.

        Args:
            browser: FidelityBrowser instance.
        """
        self.browser = browser

    def transfer(
        self,
        source_account: str,
        destination_account: str,
        amount: float,
    ) -> bool:
        """
        Transfer funds between Fidelity accounts.

        Args:
            source_account: Account number to transfer from.
            destination_account: Account number to transfer to.
            amount: Amount to transfer.

        Returns:
            True if successful, False otherwise.

        Raises:
            AccountNotFoundError: If source or destination account not found.
            InsufficientFundsError: If insufficient funds in source account.
        """
        try:
            page = self.browser.page

            # Navigate to transfer page
            self.browser.goto(URLs.TRANSFER)
            self.browser.wait_for_loading()

            # Select source account
            source_value = self._select_account(
                Selectors.FROM_DROPDOWN,
                source_account,
                "source",
            )
            if not source_value:
                return False

            self.browser.wait_for_loading()

            # Select destination account
            dest_value = self._select_account(
                Selectors.TO_DROPDOWN,
                destination_account,
                "destination",
            )
            if not dest_value:
                return False

            self.browser.wait_for_loading()

            # Check available balance
            balance_text = page.locator(Selectors.WITHDRAWAL_BALANCE_ROW).inner_text()
            available = float(balance_text.replace("$", "").replace(",", ""))

            amount = round(amount, 2)
            if amount > available:
                print(f"Insufficient funds: ${available} available, ${amount} requested")
                return False

            # Enter amount
            page.locator(Selectors.TRANSFER_AMOUNT_INPUT).fill(str(amount))

            # Submit transfer
            page.get_by_role("button", name="Continue").click()
            self.browser.wait_for_loading()

            page.get_by_role("button", name="Submit").click()
            self.browser.wait_for_loading()

            # Verify success
            try:
                page.get_by_text("Request submitted").wait_for(state="visible")
                return True
            except PlaywrightTimeoutError:
                print("Transfer submission failed")
                return False

        except Exception as e:
            print(f"Transfer error: {e}")
            return False

    def _select_account(
        self,
        dropdown_label: str,
        account_number: str,
        account_type: str,
    ) -> str | None:
        """
        Select an account from a dropdown.

        Returns:
            The option value if found, None otherwise.
        """
        page = self.browser.page
        select = page.get_by_label(dropdown_label, exact=(dropdown_label == "To"))
        options = select.locator("option").all()

        for option in options:
            if account_number in option.inner_text():
                value = option.get_attribute("value")
                select.select_option(value)
                return value

        print(f"{account_type.title()} account {account_number} not found")
        return None
