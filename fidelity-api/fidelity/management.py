"""
Account management module for Fidelity API.

Handles account creation, penny stock trading, and account nicknames.
"""

from typing import Optional, Literal
import re

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors, Patterns, Timeouts
from .exceptions import AccountCreationError


class FidelityManagement:
    """Handles Fidelity account management operations."""

    def __init__(self, browser: FidelityBrowser) -> None:
        """
        Initialize management handler.

        Args:
            browser: FidelityBrowser instance.
        """
        self.browser = browser
        self.new_account_number: Optional[str] = None

    def open_account(
        self,
        account_type: Literal["roth", "brokerage"],
    ) -> bool:
        """
        Open a new Fidelity account.

        Note: Use login(save_device=False) to ensure 2FA is triggered,
        which makes this flow more reliable.

        Args:
            account_type: Type of account to open ("roth" or "brokerage").

        Returns:
            True if successful. New account number stored in self.new_account_number.
        """
        try:
            if account_type == "roth":
                return self._open_roth_account()
            elif account_type == "brokerage":
                return self._open_brokerage_account()
            return False
        except Exception as e:
            print(f"Account opening error: {e}")
            return False

    def _open_roth_account(self) -> bool:
        """Open a Roth IRA account."""
        page = self.browser.page

        page.goto(URLs.OPEN_ROTH)
        self.browser.wait_for_loading()

        page.get_by_role("button", name="Open account").click()
        self.browser.wait_for_loading(timeout=Timeouts.LONG)

        # Wait for success message
        congrats = page.get_by_role("heading", name="Congratulations, your account")
        congrats.wait_for(state="visible")

        # Extract account number
        acc_heading = page.get_by_role("heading", name="Your account number is")
        self.new_account_number = acc_heading.text_content().replace(
            "Your account number is ", ""
        )

        return True

    def _open_brokerage_account(self) -> bool:
        """Open a brokerage account."""
        page = self.browser.page

        # Get current accounts for comparison
        old_accounts = self._get_account_numbers()

        page.goto(URLs.OPEN_BROKERAGE)
        self.browser.wait_for_loading()

        # First section (may not be present if resuming)
        if page.get_by_role("heading", name="Account ownership").is_visible():
            page.get_by_role("button", name="Next").click()
            self.browser.wait_for_loading()

        # Second section (may not be present)
        try:
            page.get_by_role("button", name="Next").click(timeout=Timeouts.MEDIUM)
            self.browser.wait_for_loading()
        except PlaywrightTimeoutError:
            pass

        # Open account
        page.get_by_role("button", name="Open account").click()
        self.browser.wait_for_loading(timeout=Timeouts.LONG)
        page.wait_for_load_state(state="load")
        self.browser.wait_for_loading()

        # Find new account by comparing lists
        new_accounts = self._get_account_numbers()
        self.new_account_number = None

        for acc in new_accounts:
            if acc not in old_accounts:
                self.new_account_number = acc
                return True

        return False

    def _get_account_numbers(self) -> set[str]:
        """Get current account numbers from transfers dropdown."""
        page = self.browser.page
        accounts = set()

        page.goto(URLs.TRANSFER)
        self.browser.wait_for_loading()

        from_select = page.get_by_label("From")
        options = from_select.locator("option").all()

        for option in options:
            match = re.search(Patterns.ACCOUNT_NUMBER, option.inner_text())
            if match:
                accounts.add(match.group(0))

        return accounts

    def enable_penny_stocks(self, account: str) -> bool:
        """
        Enable penny stock trading for an account.

        Note: Use login(save_device=False) for reliable operation.

        Args:
            account: Account number to enable penny stocks for.

        Returns:
            True if successful or already enabled.
        """
        try:
            page = self.browser.page

            page.goto(URLs.FEATURES)
            page.get_by_label("Manage Penny Stock Trading").click()

            page.wait_for_load_state(state="load", timeout=Timeouts.DEFAULT)
            self.browser.wait_for_loading()

            # Click Start button
            page.get_by_role("button", name="Start").click(timeout=Timeouts.MEDIUM)
            self.browser.wait_for_loading()

            # Check if already enabled
            try:
                page.get_by_text("This feature is already enabled").wait_for(
                    state="visible", timeout=1000
                )
                print("Penny stock trading already enabled for all accounts")
                return True
            except PlaywrightTimeoutError:
                pass

            # Wait for account selection page
            page.get_by_role("heading", name="Select an account").wait_for(
                timeout=Timeouts.DEFAULT, state="visible"
            )

            # Try checkbox version
            checkbox = page.locator("label").filter(has_text=account)
            if checkbox.is_visible():
                checkbox.click()

            # Try dropdown version
            dropdown = page.get_by_label("Your eligible accounts")
            if dropdown.is_visible():
                dropdown.select_option(account)

            # Continue with enabling
            page.get_by_role("button", name="Continue").click()

            try:
                self.browser.wait_for_loading(timeout=Timeouts.LONG)
            except PlaywrightTimeoutError:
                # Retry on timeout
                return self.enable_penny_stocks(account)

            # Wait for terms page
            page.wait_for_load_state(state="load")
            self.browser.wait_for_loading()

            if (
                URLs.PENNY_STOCK_TERMS_1 not in page.url
                and URLs.PENNY_STOCK_TERMS_2 not in page.url
            ):
                return False

            # Accept terms
            page.query_selector(Selectors.PENNY_STOCK_CHECKBOX).click()
            page.get_by_role("button", name="Submit").click()

            self.browser.wait_for_loading()
            page.wait_for_load_state(state="load")
            self.browser.wait_for_loading()

            # Verify success
            try:
                page.get_by_text("Your account is now enabled.").wait_for(
                    state="visible", timeout=Timeouts.MEDIUM
                )
                return True
            except PlaywrightTimeoutError:
                print("Could not verify penny stock enablement")
                return False

        except Exception as e:
            print(f"Penny stock enablement error: {e}")
            return False

    def nickname_account(self, account_number: str, nickname: str) -> bool:
        """
        Set a nickname for an account.

        Args:
            account_number: Account number to nickname.
            nickname: New nickname for the account.

        Returns:
            True if successful.
        """
        try:
            page = self.browser.page

            page.goto(URLs.SUMMARY)
            self.browser.wait_for_loading()

            # Wait for customize button
            page.get_by_label(Selectors.CUSTOMIZE_ACCOUNTS, exact=True).wait_for(
                state="visible"
            )

            # Check for new UI
            new_ui = page.get_by_test_id(
                Selectors.CUSTOMIZE_BUTTON_NEW
            ).get_by_label(Selectors.CUSTOMIZE_ACCOUNTS).is_visible()

            # Open customization modal
            page.get_by_label(Selectors.CUSTOMIZE_ACCOUNTS, exact=True).click()
            page.get_by_text("Display preferences").wait_for(state="visible")

            # Find the account entry
            page.locator(Selectors.CUSTOMIZE_MODAL_ITEM).first.wait_for(state="visible")
            entries = page.locator(Selectors.CUSTOMIZE_MODAL_ITEM).all()

            selected_entry = None
            for entry in entries:
                if account_number in entry.inner_text():
                    selected_entry = entry
                    break

            if not selected_entry:
                print(f"Account {account_number} not found in customization modal")
                return False

            # Select and rename
            page.wait_for_timeout(500)
            selected_entry.click()
            page.wait_for_timeout(500)

            page.get_by_role("button", name="Rename").click()

            # Enter new nickname
            if new_ui:
                page.get_by_test_id(Selectors.RENAME_INPUT_NEW).get_by_role(
                    "textbox"
                ).fill(nickname)
            else:
                page.get_by_label("Accounts", exact=True).get_by_role(
                    "textbox"
                ).fill(nickname)

            page.get_by_role("button", name="save").click()

            # Wait for save
            self.browser.wait_for_loading()
            self.browser.wait_for_loading()

            return True

        except Exception as e:
            print(f"Nickname error: {e}")
            return False
