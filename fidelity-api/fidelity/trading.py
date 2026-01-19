"""
Trading module for Fidelity API.

Handles buy/sell transactions with support for extended hours and limit orders.
"""

from typing import Optional, Literal

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors, Timeouts
from .models import OrderResult, TradeAlert
from .exceptions import TransactionError, OrderPreviewError, OrderSubmitError


# Error message patterns for classification
ERROR_PATTERNS = {
    TradeAlert.INVALID_TICKER: [
        "symbol is not valid",
        "invalid symbol",
        "not found",
        "symbol not recognized",
        "unable to find",
    ],
    TradeAlert.INSUFFICIENT_FUNDS: [
        "insufficient funds",
        "not enough buying power",
        "exceeds your buying power",
        "insufficient buying power",
        "available to trade",
        "cash available",
    ],
    TradeAlert.NO_POSITION: [
        "you don't own",
        "no shares",
        "don't have any shares",
        "position not found",
        "you do not own",
        "don't own any",
    ],
    TradeAlert.INSUFFICIENT_SHARES: [
        "exceeds your available",
        "not enough shares",
        "insufficient shares",
        "exceeds the quantity",
    ],
    TradeAlert.SHARES_RESTRICTED: [
        "shares are restricted",
        "held for settlement",
        "margin requirement",
        "not available for sale",
    ],
    TradeAlert.MARKET_CLOSED: [
        "market is closed",
        "outside market hours",
        "market hours",
        "not accepted outside",
    ],
    TradeAlert.STOCK_NOT_TRADEABLE: [
        "not available for trading",
        "cannot be traded",
        "otc",
        "penny stock",
        "trading restricted",
    ],
    TradeAlert.ACCOUNT_RESTRICTED: [
        "account is restricted",
        "account restriction",
        "trading suspended",
    ],
    TradeAlert.SESSION_EXPIRED: [
        "session expired",
        "logged out",
        "please log in",
        "authentication",
    ],
}


def classify_error(error_message: str) -> TradeAlert:
    """Classify an error message into a TradeAlert code."""
    if not error_message:
        return TradeAlert.UNKNOWN

    lower_msg = error_message.lower()
    for alert, patterns in ERROR_PATTERNS.items():
        for pattern in patterns:
            if pattern in lower_msg:
                return alert

    return TradeAlert.ORDER_REJECTED


class FidelityTrading:
    """Handles Fidelity trading operations."""

    def __init__(self, browser: FidelityBrowser) -> None:
        """
        Initialize trading handler.

        Args:
            browser: FidelityBrowser instance.
        """
        self.browser = browser

    def transaction(
        self,
        stock: str,
        quantity: float,
        action: Literal["buy", "sell"],
        account: str,
        dry: bool = True,
        limit_price: Optional[float] = None,
    ) -> OrderResult:
        """
        Execute a buy or sell transaction.

        For penny stocks (< $1), limit orders are used automatically.
        Extended hours trading is enabled when available.

        Note: If changing stocks between calls, reload the page first:
            client.browser.page.reload()

        Args:
            stock: Ticker symbol.
            quantity: Number of shares.
            action: "buy" or "sell".
            account: Account number to trade in.
            dry: If True, preview only (no actual order). Default True.
            limit_price: Optional limit price (uses market otherwise).

        Returns:
            OrderResult with success status and error message if failed.
        """
        try:
            # Navigate to trade page
            self._navigate_to_trade_page()

            # Select account
            self._select_account(account)

            # Enter symbol and get quote
            last_price = self._enter_symbol(stock)

            # Handle extended hours
            extended, precision = self._setup_extended_hours()
            if extended:
                last_price = self._get_extended_price(last_price)

            # Select action (buy/sell)
            if not self._select_action(action):
                return OrderResult(
                    success=False,
                    error_message=f"Could not select '{action}' after 5 attempts",
                    alert=TradeAlert.UNKNOWN,
                )

            # Enter quantity
            self._enter_quantity(quantity)

            # Set order type (market or limit)
            self._set_order_type(
                last_price=last_price,
                action=action,
                extended=extended,
                precision=precision,
                limit_price=limit_price,
            )

            # Preview order
            preview_error = self._preview_order()
            if preview_error:
                alert = classify_error(preview_error)
                return OrderResult(
                    success=False,
                    error_message=preview_error,
                    alert=alert,
                )

            # Validate preview
            if not self._validate_preview(account, stock, action, quantity):
                return OrderResult(
                    success=False,
                    error_message="Order preview doesn't match expected values",
                    alert=TradeAlert.ORDER_REJECTED,
                )

            # Submit if not dry run
            if not dry:
                return self._submit_order()

            return OrderResult(success=True, error_message=None, alert=TradeAlert.SUCCESS)

        except PlaywrightTimeoutError as e:
            return OrderResult(
                success=False,
                error_message=f"Timeout during transaction: {e}",
                alert=TradeAlert.TIMEOUT,
            )
        except Exception as e:
            error_msg = f"Transaction error: {e}"
            return OrderResult(
                success=False,
                error_message=error_msg,
                alert=classify_error(str(e)),
            )

    def _navigate_to_trade_page(self) -> None:
        """Navigate to the trade entry page."""
        page = self.browser.page
        page.bring_to_front()  # Ensure browser has focus
        page.wait_for_load_state(state="load")
        if page.url != URLs.TRADE_EQUITY:
            page.goto(URLs.TRADE_EQUITY)

    def _select_account(self, account: str) -> None:
        """Select the trading account from dropdown."""
        page = self.browser.page

        page.query_selector(Selectors.ACCOUNT_DROPDOWN).click()

        account_locator = page.locator("button[role='option']").filter(
            has_text=account.upper()
        )

        if not account_locator.is_visible():
            # Retry after reload
            page.reload()
            page.query_selector(Selectors.ACCOUNT_DROPDOWN).click()

        account_locator.click()
        page.wait_for_timeout(3000)

    def _enter_symbol(self, stock: str) -> float:
        """Enter the stock symbol and get the quote."""
        page = self.browser.page

        # Click input first to ensure focus (force=True bypasses overlay)
        symbol_input = page.locator(Selectors.SYMBOL_INPUT)
        symbol_input.click(force=True)
        symbol_input.fill(stock.upper())
        page.wait_for_timeout(500)

        # Press Enter using locator method (more reliable than keyboard.press)
        symbol_input.press("Enter")
        page.wait_for_timeout(2000)

        # Wait for quote panel with longer timeout
        page.locator(Selectors.QUOTE_PANEL).wait_for(timeout=Timeouts.MEDIUM)

        # Get last price
        price_text = page.query_selector(Selectors.LAST_PRICE).text_content()
        return float(price_text.replace("$", "").replace(",", ""))

    def _setup_extended_hours(self) -> tuple[bool, int]:
        """
        Set up extended hours trading if available.

        Returns:
            Tuple of (extended_enabled, price_precision).
        """
        page = self.browser.page
        extended = False
        precision = 3

        # Check for extended hours button
        extended_wrapper = page.locator(Selectors.EXTENDED_HOURS_WRAPPER)
        extended_btn = page.locator(Selectors.EXTENDED_HOURS_BUTTON)

        if extended_btn.is_visible():
            # Check if already enabled
            class_attr = extended_wrapper.first.get_attribute("class") or ""
            if "pvd-switch--on" not in class_attr:
                extended_btn.click()
                page.wait_for_timeout(1000)

            extended = True
            precision = 2

        # Fallback to text-based check
        elif page.get_by_text("Extended hours trading").is_visible():
            off_text = page.get_by_text(
                "Extended hours trading: OffUntil 8:00 PM ET"
            )
            if off_text.is_visible():
                off_text.check()
            extended = True
            precision = 2

        # Ensure expanded ticket view
        expand_btn = page.get_by_role("button", name="View expanded ticket")
        if expand_btn.is_visible():
            expand_btn.click()
            page.get_by_role("button", name="Calculate shares").wait_for(
                timeout=Timeouts.SHORT
            )

        return extended, precision

    def _get_extended_price(self, fallback_price: float) -> float:
        """Get the extended hours price if available."""
        page = self.browser.page
        price_elem = page.locator(Selectors.LAST_PRICE)
        if price_elem.is_visible():
            price_text = page.query_selector(Selectors.LAST_PRICE).text_content()
            return float(price_text.replace("$", "").replace(",", ""))
        return fallback_price

    def _select_action(self, action: str) -> bool:
        """
        Select buy or sell action.

        Returns:
            True if successful, False otherwise.
        """
        page = self.browser.page
        action_dropdown = page.locator(Selectors.ACTION_DROPDOWN)
        target_option = page.get_by_role(
            "option", name=action.lower().title(), exact=True
        )

        for attempt in range(5):
            try:
                if not target_option.is_visible():
                    action_dropdown.click(force=True)
                    page.wait_for_timeout(500)

                target_option.click(timeout=3000)
                return True

            except (PlaywrightTimeoutError, Exception) as e:
                print(f"Attempt {attempt + 1} failed to select '{action}': {e}")
                page.wait_for_timeout(1000)

        return False

    def _enter_quantity(self, quantity: float) -> None:
        """Enter the order quantity."""
        page = self.browser.page
        # Try multiple approaches to find and fill quantity input
        qty_input = page.locator(Selectors.QUANTITY_INPUT)
        if not qty_input.is_visible():
            qty_input = page.get_by_placeholder("Quantity")
        if not qty_input.is_visible():
            qty_input = page.get_by_label("Quantity")

        qty_input.click(force=True)
        qty_input.fill(str(int(quantity)))

    def _set_order_type(
        self,
        last_price: float,
        action: str,
        extended: bool,
        precision: int,
        limit_price: Optional[float],
    ) -> None:
        """Set the order type (market or limit)."""
        page = self.browser.page

        # Use limit order for penny stocks, extended hours, or explicit limit
        if last_price < 1 or extended or limit_price is not None:
            self._set_limit_order(last_price, action, precision, limit_price)
        else:
            self._set_market_order()

    def _set_limit_order(
        self,
        last_price: float,
        action: str,
        precision: int,
        limit_price: Optional[float],
    ) -> None:
        """Set up a limit order."""
        page = self.browser.page

        # Calculate limit price if not provided
        if limit_price is not None:
            price = limit_price
        else:
            diff = 0.01 if last_price > 0.1 else 0.0001
            if action.lower() == "buy":
                price = round(last_price + diff, precision)
            else:
                price = round(last_price - diff, precision)

        # Select limit order type
        page.query_selector(
            "#dest-dropdownlist-button-ordertype > span:nth-child(1)"
        ).click()
        page.get_by_role("option", name="Limit", exact=True).click()

        # Enter limit price
        page.get_by_text("Limit price", exact=True).click()
        page.get_by_label("Limit price").fill(str(price))

    def _set_market_order(self) -> None:
        """Set up a market order."""
        page = self.browser.page
        # Try multiple ways to find the order type dropdown
        order_dropdown = page.locator(Selectors.ORDER_TYPE_CONTAINER)
        if not order_dropdown.is_visible():
            order_dropdown = page.locator(Selectors.ORDER_TYPE_DROPDOWN)
        if not order_dropdown.is_visible():
            order_dropdown = page.get_by_text("Order type", exact=False).first

        order_dropdown.click(force=True)
        page.wait_for_timeout(500)
        page.get_by_role("option", name="Market", exact=True).click()

    def _preview_order(self) -> Optional[str]:
        """
        Preview the order and check for errors.

        Returns:
            Error message if failed, None if successful.
        """
        page = self.browser.page

        page.get_by_role("button", name="Preview order").click()
        self.browser.wait_for_loading()

        # Check if Place Order button appears
        try:
            page.get_by_role("button", name="Place order", exact=False).wait_for(
                timeout=Timeouts.SHORT, state="visible"
            )
            return None
        except PlaywrightTimeoutError:
            pass

        # Try to extract error message
        return self._extract_error_message()

    def _extract_error_message(self) -> str:
        """Extract error message from the page."""
        page = self.browser.page
        error_message = ""

        # Try different error selectors
        try:
            error_message = (
                page.get_by_label("Error")
                .locator("div")
                .filter(has_text="critical")
                .nth(2)
                .text_content(timeout=2000)
            )
            page.get_by_role("button", name=Selectors.DIALOG_CLOSE).click()
        except Exception:
            pass

        if not error_message:
            try:
                error_message = page.wait_for_selector(
                    '.pvd-inline-alert__content font[color="red"]',
                    timeout=2000,
                ).text_content()
                page.get_by_role("button", name=Selectors.DIALOG_CLOSE).click()
            except Exception:
                pass

        if error_message:
            # Clean up the error message
            cleaned = "".join(
                c for i, c in enumerate(error_message)
                if c not in " \n\t" or (i > 0 and error_message[i - 1] != " ")
            )
            return cleaned.replace("critical", "").strip()

        # Reload page if we couldn't close error dialog
        page.reload()
        return "Could not retrieve error message"

    def _validate_preview(
        self,
        account: str,
        stock: str,
        action: str,
        quantity: float,
    ) -> bool:
        """Validate the order preview matches expected values."""
        page = self.browser.page

        checks = [
            page.locator("preview").filter(has_text=account.upper()).is_visible(),
            page.get_by_text(f"Symbol{stock.upper()}", exact=True).is_visible(),
            page.get_by_text(f"Action{action.lower().title()}").is_visible(),
            page.get_by_text(f"Quantity{quantity}").is_visible(),
        ]

        return all(checks)

    def _submit_order(self) -> OrderResult:
        """Submit the order."""
        page = self.browser.page

        page.get_by_role("button", name="Place order", exact=False).first.click()

        try:
            self.browser.wait_for_loading()
            page.get_by_text("Order received", exact=True).wait_for(
                timeout=10000, state="visible"
            )
            return OrderResult(success=True, error_message=None, alert=TradeAlert.SUCCESS)
        except PlaywrightTimeoutError as e:
            return OrderResult(
                success=False,
                error_message=f"Timeout waiting for order confirmation: {e}",
                alert=TradeAlert.TIMEOUT,
            )
