"""
Async Fidelity Client for use in async contexts (FastAPI, asyncio, etc).

This is a standalone async implementation that doesn't share code with
the sync version to avoid complexity. Use this for FastAPI/uvicorn.
"""

import traceback
from typing import Optional
from dataclasses import dataclass

import pyotp
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowserAsync
from .selectors import URLs, Selectors, Timeouts
from .models import LoginResult, Account, Stock


class FidelityClientAsync:
    """
    Async Fidelity client for use with FastAPI/uvicorn.

    Usage:
        client = FidelityClientAsync()
        await client.initialize()
        result = await client.login(username, password, totp_secret)
        await client.close()

    Or with async context manager:
        async with FidelityClientAsync() as client:
            await client.login(...)
    """

    def __init__(
        self,
        headless: bool = True,
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
        self._browser = FidelityBrowserAsync(
            headless=headless,
            save_state=save_state,
            profile_path=profile_path,
            title=title,
            debug=debug,
        )
        self._initialized = False

    async def initialize(self) -> "FidelityClientAsync":
        """Initialize the browser. Must be called before other methods."""
        await self._browser.initialize()
        self._initialized = True
        return self

    async def close(self) -> None:
        """Close the browser and clean up."""
        await self._browser.close()
        self._initialized = False

    async def __aenter__(self) -> "FidelityClientAsync":
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()

    # =========================================================================
    # Authentication
    # =========================================================================

    async def login(
        self,
        username: str,
        password: str,
        totp_secret: Optional[str] = None,
        save_device: bool = False,
    ) -> tuple[bool, bool]:
        """
        Log into Fidelity.

        Args:
            username: Fidelity username
            password: Fidelity password
            totp_secret: TOTP secret for authenticator (optional)
            save_device: Save device to skip 2FA in future

        Returns:
            Tuple of (step1_success, fully_logged_in)
        """
        try:
            page = self._browser.page

            # Navigate to login page
            await page.goto(URLs.LOGIN)
            await page.wait_for_timeout(5000)
            await page.goto(URLs.LOGIN)

            # Fill credentials
            username_field = page.get_by_label("Username", exact=True)
            await username_field.click()
            await username_field.fill(username)

            password_field = page.get_by_label("Password", exact=True)
            await password_field.click()
            await password_field.fill(password)

            await page.get_by_role("button", name="Log in").click()

            # Wait for load
            await self._browser.wait_for_loading()
            await page.wait_for_timeout(1000)
            await self._browser.wait_for_loading()

            # Check if already logged in
            if "summary" in page.url:
                return (True, True)

            # Normalize TOTP
            if totp_secret == "NA":
                totp_secret = None

            # Handle 2FA
            if "login" in page.url:
                return await self._handle_2fa(totp_secret, save_device)

            return (False, False)

        except PlaywrightTimeoutError:
            traceback.print_exc()
            return (False, False)
        except Exception as e:
            print(f"Login error: {e}")
            traceback.print_exc()
            return (False, False)

    async def _handle_2fa(
        self,
        totp_secret: Optional[str],
        save_device: bool,
    ) -> tuple[bool, bool]:
        """Handle 2FA flow."""
        page = self._browser.page

        await self._browser.wait_for_loading()
        widget = page.locator(Selectors.LOGIN_WIDGET).first
        await widget.wait_for(timeout=Timeouts.SHORT, state="visible")

        # Check for TOTP prompt
        totp_heading = page.get_by_role("heading", name="Enter the code from your")
        if totp_secret and await totp_heading.is_visible():
            return await self._complete_totp_login(totp_secret, save_device)

        # Fall back to SMS if no TOTP
        try_another = page.get_by_role("link", name="Try another way")
        if await try_another.is_visible():
            if save_device:
                await self._check_save_device_box()
            await try_another.click()

        await page.get_by_role("button", name="Text me the code").click()
        await page.get_by_placeholder(Selectors.TOTP_INPUT).click()

        return (True, False)

    async def _complete_totp_login(
        self,
        totp_secret: str,
        save_device: bool,
    ) -> tuple[bool, bool]:
        """Complete login with TOTP."""
        page = self._browser.page

        code = pyotp.TOTP(totp_secret).now()
        totp_input = page.get_by_placeholder(Selectors.TOTP_INPUT)
        await totp_input.click()
        await totp_input.fill(code)

        if save_device:
            await self._check_save_device_box()

        await page.get_by_role("button", name="Continue").click()
        await self._browser.wait_for_loading()
        await page.wait_for_url(URLs.SUMMARY, timeout=Timeouts.LOGIN)

        return (True, True)

    async def _check_save_device_box(self) -> None:
        """Check the save device checkbox."""
        page = self._browser.page
        checkbox = page.locator("label").filter(has_text="Don't ask me again on this")
        await checkbox.check()

    # =========================================================================
    # Account Info
    # =========================================================================

    async def get_account_info(self) -> dict[str, Account]:
        """
        Get account information.

        Returns:
            Dict mapping account numbers to Account objects.
        """
        try:
            page = self._browser.page
            await page.goto(URLs.POSITIONS)
            await self._browser.wait_for_loading()

            accounts: dict[str, Account] = {}

            # Get all account containers
            containers = page.locator(Selectors.ACCOUNT_CONTAINER)
            count = await containers.count()

            for i in range(count):
                container = containers.nth(i)

                # Get account number
                acc_num_elem = container.locator(Selectors.ACCOUNT_NUMBER).first
                acc_num = await acc_num_elem.inner_text()
                acc_num = acc_num.strip()

                # Get balance
                try:
                    balance_elem = container.locator(Selectors.ACCOUNT_BALANCE).first
                    balance_text = await balance_elem.inner_text()
                    balance = float(balance_text.replace("$", "").replace(",", ""))
                except Exception:
                    balance = 0.0

                # Get positions
                stocks = []
                position_rows = container.locator(Selectors.POSITION_ROW)
                pos_count = await position_rows.count()

                for j in range(pos_count):
                    row = position_rows.nth(j)
                    try:
                        ticker_elem = row.locator(Selectors.POSITION_TICKER).first
                        ticker = await ticker_elem.inner_text()

                        qty_elem = row.locator(Selectors.POSITION_QUANTITY).first
                        qty_text = await qty_elem.inner_text()
                        qty = float(qty_text.replace(",", ""))

                        price_elem = row.locator(Selectors.POSITION_PRICE).first
                        price_text = await price_elem.inner_text()
                        price = float(price_text.replace("$", "").replace(",", ""))

                        value_elem = row.locator(Selectors.POSITION_VALUE).first
                        value_text = await value_elem.inner_text()
                        value = float(value_text.replace("$", "").replace(",", ""))

                        stocks.append(Stock(
                            ticker=ticker.strip(),
                            quantity=qty,
                            last_price=price,
                            value=value,
                        ))
                    except Exception:
                        continue

                accounts[acc_num] = Account(
                    account_number=acc_num,
                    balance=balance,
                    stocks=stocks,
                )

            return accounts

        except Exception as e:
            print(f"Error getting account info: {e}")
            traceback.print_exc()
            return {}

    # =========================================================================
    # Trading
    # =========================================================================

    async def transaction(
        self,
        stock: str,
        quantity: float,
        action: str,
        account: str,
        dry: bool = True,
        limit_price: Optional[float] = None,
    ) -> tuple[bool, Optional[str]]:
        """
        Execute a trade.

        Args:
            stock: Ticker symbol
            quantity: Number of shares
            action: "buy" or "sell"
            account: Account number
            dry: If True, preview only (don't submit)
            limit_price: Optional limit price

        Returns:
            Tuple of (success, error_message)
        """
        try:
            page = self._browser.page

            # Navigate to trade page
            await page.goto(URLs.TRADE)
            await self._browser.wait_for_loading()

            # Select account
            account_dropdown = page.locator(Selectors.ACCOUNT_DROPDOWN)
            await account_dropdown.click()
            account_option = page.locator(f"text={account}")
            await account_option.click()

            # Enter symbol
            symbol_input = page.locator(Selectors.SYMBOL_INPUT)
            await symbol_input.fill(stock.upper())
            await page.wait_for_timeout(500)

            # Select action
            action_select = page.locator(Selectors.ACTION_SELECT)
            await action_select.select_option(action.lower())

            # Enter quantity
            qty_input = page.locator(Selectors.QUANTITY_INPUT)
            await qty_input.fill(str(int(quantity)))

            # Set order type
            if limit_price:
                order_type = page.locator(Selectors.ORDER_TYPE_SELECT)
                await order_type.select_option("limit")
                limit_input = page.locator(Selectors.LIMIT_PRICE_INPUT)
                await limit_input.fill(str(limit_price))

            # Preview order
            preview_btn = page.get_by_role("button", name="Preview order")
            await preview_btn.click()
            await self._browser.wait_for_loading()

            # Check for errors
            error_elem = page.locator(Selectors.ORDER_ERROR)
            if await error_elem.is_visible():
                error_text = await error_elem.inner_text()
                return (False, error_text)

            if dry:
                return (True, None)

            # Submit order
            submit_btn = page.get_by_role("button", name="Place order")
            await submit_btn.click()
            await self._browser.wait_for_loading()

            # Check for confirmation
            confirm = page.locator(Selectors.ORDER_CONFIRMATION)
            if await confirm.is_visible():
                return (True, None)

            return (False, "Order may not have been placed")

        except Exception as e:
            print(f"Transaction error: {e}")
            traceback.print_exc()
            return (False, str(e))
