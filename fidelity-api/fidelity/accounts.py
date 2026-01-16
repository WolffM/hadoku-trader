"""
Account management module for Fidelity API.

Handles account info, positions, and holdings.
"""

import os
import re
import csv
from typing import Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors, Patterns, Timeouts
from .models import Account, Stock
from .exceptions import AccountError


class FidelityAccounts:
    """Handles Fidelity account information and positions."""

    def __init__(self, browser: FidelityBrowser) -> None:
        """
        Initialize accounts handler.

        Args:
            browser: FidelityBrowser instance.
        """
        self.browser = browser
        self._accounts: dict[str, Account] = {}

    @property
    def accounts(self) -> dict[str, Account]:
        """Get the current accounts dictionary."""
        return self._accounts

    def get_account(self, account_number: str) -> Optional[Account]:
        """Get a specific account by number."""
        return self._accounts.get(account_number)

    def get_account_info(self) -> dict[str, dict]:
        """
        Get account information by downloading the positions CSV.

        Note: This will miss accounts with no holdings.
        Use get_account_list() for a complete list.

        Returns:
            Dictionary of accounts keyed by account number.
            Each value contains balance, nickname, and stocks list.
        """
        try:
            page = self.browser.page

            # Navigate to positions page
            self.browser.goto(URLs.POSITIONS)
            self.browser.wait_for_loading()
            page.wait_for_timeout(1000)
            self.browser.wait_for_loading(timeout=Timeouts.VERY_LONG)

            # Download positions CSV
            csv_path = self._download_positions_csv()
            if not csv_path:
                return {}

            # Parse the CSV
            self._parse_positions_csv(csv_path)

            # Clean up
            os.remove(csv_path)

            # Return backward-compatible dict format
            return {num: acc.to_dict() for num, acc in self._accounts.items()}

        except Exception as e:
            print(f"Error getting account info: {e}")
            return {}

    def _download_positions_csv(self) -> Optional[str]:
        """Download the positions CSV file."""
        page = self.browser.page

        # Try new UI first
        try:
            page.get_by_role("button", name=Selectors.AVAILABLE_ACTIONS_BUTTON).click(
                timeout=Timeouts.DOWNLOAD
            )
            with page.expect_download() as download_info:
                page.get_by_role("menuitem", name="Download").click()
            download = download_info.value
        except PlaywrightTimeoutError:
            # Try old UI
            try:
                with page.expect_download() as download_info:
                    page.get_by_label(Selectors.DOWNLOAD_POSITIONS).click(
                        timeout=Timeouts.DOWNLOAD
                    )
                download = download_info.value
            except PlaywrightTimeoutError:
                print("Could not download positions CSV")
                return None

        # Save the file
        csv_path = os.path.join(os.getcwd(), download.suggested_filename)
        download.save_as(csv_path)
        return csv_path

    def _parse_positions_csv(self, csv_path: str) -> None:
        """Parse the positions CSV and populate accounts."""
        required_fields = [
            "Account Number",
            "Account Name",
            "Symbol",
            "Description",
            "Quantity",
            "Last Price",
            "Last Price Change",
            "Current Value",
        ]

        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)

            # Verify required fields
            if not set(required_fields).issubset(set(reader.fieldnames or [])):
                raise AccountError("Missing required fields in positions CSV")

            for row in reader:
                self._process_csv_row(row)

    def _process_csv_row(self, row: dict) -> None:
        """Process a single row from the positions CSV."""
        account_number = row.get("Account Number")

        # Skip invalid rows
        if not account_number or "and" in account_number:
            return

        # Skip Fidelity-managed accounts
        if account_number.startswith("Y"):
            return

        # Parse values
        ticker = str(row.get("Symbol", ""))
        current_value = self._parse_currency(row.get("Current Value", ""))
        last_price = self._parse_currency(row.get("Last Price", ""))
        last_price_change = self._parse_currency(row.get("Last Price Change", ""))
        quantity = self._parse_number(row.get("Quantity", ""))

        # Handle pending activity
        if "Pending" in ticker:
            current_value = last_price_change

        # Skip rows without value
        if current_value == 0:
            return

        # Use current value as last price if not available
        if last_price == 0:
            last_price = current_value

        # Default quantity to 1 for cash positions
        if quantity == 0:
            quantity = 1

        # Create stock
        stock = Stock(
            ticker=ticker,
            quantity=quantity,
            last_price=last_price,
            value=current_value,
        )

        # Add to account
        account_name = row.get("Account Name", "")
        if account_number not in self._accounts:
            self._accounts[account_number] = Account(
                account_number=account_number,
                nickname=account_name,
            )
        self._accounts[account_number].add_stock(stock)

    def _parse_currency(self, value: str) -> float:
        """Parse a currency string to float."""
        try:
            clean = str(value).replace("$", "").replace(",", "").replace("-", "")
            return float(clean) if clean else 0.0
        except ValueError:
            return 0.0

    def _parse_number(self, value: str) -> float:
        """Parse a number string to float."""
        try:
            clean = str(value).replace(",", "").replace("-", "")
            return float(clean) if clean else 0.0
        except ValueError:
            return 0.0

    def get_account_list(
        self,
        get_withdrawal_balance: bool = False,
    ) -> dict[str, dict]:
        """
        Get list of accounts from the transfers dropdown.

        This method finds all accounts, including those with no holdings.

        Args:
            get_withdrawal_balance: Whether to fetch available withdrawal balance.

        Returns:
            Dictionary of accounts keyed by account number.
        """
        try:
            page = self.browser.page

            # Navigate to transfers page
            self.browser.goto(URLs.TRANSFER)
            self.browser.wait_for_loading()

            # Get account options from dropdown
            from_select = page.get_by_label(Selectors.FROM_DROPDOWN)
            options = from_select.locator("option").all()

            for option in options:
                self._process_account_option(
                    option,
                    from_select,
                    get_withdrawal_balance,
                )

            return {num: acc.to_dict() for num, acc in self._accounts.items()}

        except Exception as e:
            print(f"Error getting account list: {e}")
            return {}

    def _process_account_option(
        self,
        option,
        from_select,
        get_withdrawal_balance: bool,
    ) -> None:
        """Process a single account option from the dropdown."""
        text = option.inner_text()

        # Extract account number and nickname
        account_match = re.search(Patterns.ACCOUNT_NUMBER, text)
        nickname_match = re.search(Patterns.ACCOUNT_NICKNAME, text)

        if not account_match or not nickname_match:
            return

        account_number = account_match.group(0)
        nickname = nickname_match.group(0).strip()

        # Get withdrawal balance if requested
        withdrawal_balance = 0.0
        if get_withdrawal_balance:
            value = option.get_attribute("value")
            from_select.select_option(value)
            self.browser.page.wait_for_timeout(100)
            balance_text = self.browser.page.locator(
                Selectors.WITHDRAWAL_BALANCE_ROW
            ).inner_text()
            withdrawal_balance = self._parse_currency(balance_text)

        # Update or create account
        if account_number in self._accounts:
            self._accounts[account_number].nickname = nickname
            self._accounts[account_number].withdrawal_balance = withdrawal_balance
        else:
            self._accounts[account_number] = Account(
                account_number=account_number,
                nickname=nickname,
                withdrawal_balance=withdrawal_balance,
            )

    def get_stocks_in_account(self, account_number: str) -> dict[str, float]:
        """
        Get stocks held in a specific account.

        Note: get_account_info() must be called first.

        Args:
            account_number: The account number to query.

        Returns:
            Dictionary mapping ticker symbols to quantities.
        """
        account = self._accounts.get(account_number)
        if not account:
            return {}

        return {stock.ticker: stock.quantity for stock in account.stocks}

    def summary_holdings(self) -> dict[str, dict]:
        """
        Get summary of all holdings across accounts.

        Note: get_account_info() must be called first.

        Returns:
            Dictionary of unique stocks with aggregated quantities and values.
        """
        holdings: dict[str, dict] = {}

        for account in self._accounts.values():
            for stock in account.stocks:
                if stock.ticker not in holdings:
                    holdings[stock.ticker] = {
                        "quantity": stock.quantity,
                        "last_price": stock.last_price,
                        "value": stock.value,
                    }
                else:
                    holdings[stock.ticker]["quantity"] += stock.quantity
                    holdings[stock.ticker]["value"] += stock.value

        return holdings
