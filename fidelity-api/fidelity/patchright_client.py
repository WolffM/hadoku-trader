"""
Patchright-based Fidelity Client for use in async contexts.

Uses Patchright (patched Playwright) to avoid CDP detection that triggers
Fidelity's bot detection. This is a drop-in replacement for FidelityClientAsync.

Key differences:
- Uses Chromium instead of Firefox
- Patches CDP at protocol level to avoid detection
- No need for playwright-stealth (Patchright handles it)
"""

import traceback
from typing import Optional

import pyotp
from patchright.async_api import TimeoutError as PatchrightTimeoutError

from .patchright_browser import PatchrightBrowserAsync
from .selectors import URLs, Selectors, Timeouts
from .models import Account, Stock, TradeAlert
from .trading import classify_error
from .human import (
    human_type,
    human_click,
    human_fill,
    action_delay,
    minor_delay,
    page_load_delay,
    submit_delay,
    think_delay,
    random_mouse_movement,
)


class FidelityClientPatchright:
    """
    Patchright-based Fidelity client with CDP-level stealth.

    This client uses Patchright to avoid Fidelity's bot detection which
    operates at the Chrome DevTools Protocol level.

    Usage:
        async with FidelityClientPatchright() as client:
            await client.login(username, password, totp_secret)
            await client.transaction(...)
    """

    def __init__(
        self,
        headless: bool = False,  # Patchright works best headed
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
        self._browser = PatchrightBrowserAsync(
            headless=headless,
            save_state=save_state,
            profile_path=profile_path,
            title=title,
            debug=debug,
        )
        self._initialized = False

    async def initialize(self) -> "FidelityClientPatchright":
        """Initialize the browser. Must be called before other methods."""
        await self._browser.initialize()
        self._initialized = True
        return self

    async def close(self) -> None:
        """Close the browser and clean up."""
        await self._browser.close()
        self._initialized = False

    async def __aenter__(self) -> "FidelityClientPatchright":
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
        Log into Fidelity with human-like behavior.

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

            # Navigate to login page with natural delay
            await page.goto(URLs.LOGIN)
            await page_load_delay()

            # Sometimes do a refresh like a human would if page seems slow
            await page.goto(URLs.LOGIN)
            await page_load_delay()

            # Random mouse movement to appear human
            await random_mouse_movement(page, count=2)
            await think_delay()

            # Fill credentials with human-like typing
            username_field = page.get_by_label("Username", exact=True)
            await human_type(page, username_field, username)

            # Pause between fields like a human
            await action_delay()

            password_field = page.get_by_label("Password", exact=True)
            await human_type(page, password_field, password)

            # Think before clicking login
            await submit_delay()

            # Click login with human behavior
            await human_click(page, page.get_by_role("button", name="Log in"))

            # Wait for load with natural timing
            await self._browser.wait_for_loading()
            await page_load_delay()
            await self._browser.wait_for_loading()

            # Check if already logged in (session restored from storage)
            if "summary" in page.url:
                print("[LOGIN] Already logged in (session restored)")
                # Still need to wait for page to stabilize
                await page.wait_for_timeout(2000)
                await self._verify_page_connection()
                return (True, True)

            # Normalize TOTP
            if totp_secret == "NA":
                totp_secret = None

            # Handle 2FA
            if "login" in page.url:
                return await self._handle_2fa(totp_secret, save_device)

            return (False, False)

        except PatchrightTimeoutError:
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
        """Handle 2FA flow with human-like behavior."""
        page = self._browser.page

        await self._browser.wait_for_loading()
        await think_delay()

        # Debug: print current URL and page title
        print(f"[2FA] Current URL: {page.url}")
        print(f"[2FA] Page title: {await page.title()}")

        # Wait longer for 2FA page to fully load
        await page.wait_for_timeout(2000)

        # Debug: check what's on the page
        totp_input = page.locator('input[maxlength="6"]')
        totp_count = await totp_input.count()
        print(f"[2FA] TOTP input (maxlength=6) count: {totp_count}")

        # Also try the placeholder selector
        totp_placeholder = page.get_by_placeholder(Selectors.TOTP_INPUT)
        placeholder_count = await totp_placeholder.count()
        print(f"[2FA] TOTP placeholder input count: {placeholder_count}")

        # Check for any input fields
        all_inputs = page.locator("input")
        input_count = await all_inputs.count()
        print(f"[2FA] Total input fields on page: {input_count}")

        # Try the TOTP input first
        if totp_count > 0 and await totp_input.first.is_visible():
            print("[2FA] Found TOTP input, proceeding with TOTP login")
            if totp_secret:
                return await self._complete_totp_login(totp_secret, save_device)
            return (True, False)

        # Also try placeholder-based detection
        if placeholder_count > 0 and await totp_placeholder.first.is_visible():
            print("[2FA] Found TOTP by placeholder, proceeding with TOTP login")
            if totp_secret:
                return await self._complete_totp_login(totp_secret, save_device)
            return (True, False)

        print("[2FA] No TOTP input found, checking for SMS option...")

        # Fall back to SMS if no TOTP input visible
        try_another = page.get_by_role("link", name="Try another way")
        try_another_visible = await try_another.is_visible()
        print(f"[2FA] 'Try another way' link visible: {try_another_visible}")

        if try_another_visible:
            if save_device:
                await self._check_save_device_box()
            await human_click(page, try_another)
            await page.wait_for_timeout(1000)

        sms_button = page.get_by_role("button", name="Text me the code")
        sms_visible = await sms_button.is_visible()
        print(f"[2FA] 'Text me the code' button visible: {sms_visible}")

        if sms_visible:
            await human_click(page, sms_button)
            await human_click(page, page.get_by_placeholder(Selectors.TOTP_INPUT))
            return (True, False)

        # If we get here, we couldn't find any 2FA option
        print("[2FA] ERROR: Could not find TOTP or SMS option")
        print("[2FA] Taking screenshot for debugging...")
        await page.screenshot(path="2fa_debug_patchright.png")
        return (False, False)

    async def _complete_totp_login(
        self,
        totp_secret: str,
        save_device: bool,
    ) -> tuple[bool, bool]:
        """Complete login with TOTP using human-like behavior."""
        page = self._browser.page

        # Simulate getting code from authenticator app
        await think_delay()

        code = pyotp.TOTP(totp_secret).now()
        totp_input = page.get_by_placeholder(Selectors.TOTP_INPUT)

        # Type the code like a human
        await human_type(page, totp_input, code)

        if save_device:
            await minor_delay()
            await self._check_save_device_box()

        # Pause before submitting
        await submit_delay()

        await human_click(page, page.get_by_role("button", name="Continue"))
        await self._browser.wait_for_loading()

        # Wait for navigation away from login page
        # Don't wait for specific URL since Fidelity may redirect to servicemessages first
        await page.wait_for_timeout(3000)
        print(f"[LOGIN] Post-TOTP URL: {page.url}")

        # Handle Fidelity's session refresh redirect
        # Sometimes Fidelity redirects to servicemessages.fidelity.com after login
        if "servicemessages.fidelity.com" in page.url:
            print("[LOGIN] Detected session refresh page, waiting for redirect back...")
            # Wait for redirect back to main domain (up to 30 seconds)
            try:
                await page.wait_for_url("**/digital.fidelity.com/**", timeout=30000)
                print(f"[LOGIN] Redirected back to: {page.url}")
            except Exception as e:
                print(f"[LOGIN] Redirect wait failed: {e}, checking current URL...")
                print(f"[LOGIN] Current URL: {page.url}")

        # Verify we're no longer on login page
        if "login" in page.url:
            print("[LOGIN] Still on login page after TOTP - login may have failed")
            return (False, False)

        # Navigate to summary page if we're not already there
        if "portfolio/summary" not in page.url:
            print(f"[LOGIN] Not on summary page ({page.url}), navigating there...")
            await page.goto(URLs.SUMMARY, wait_until="domcontentloaded")
            await self._browser.wait_for_loading()

        # CRITICAL: Wait for page to stabilize after login
        # Fidelity's SPA can cause context issues if we navigate too quickly
        print("[LOGIN] Waiting for page to stabilize after login...")
        await page.wait_for_timeout(3000)
        await self._browser.wait_for_loading()

        # Verify page is still connected
        await self._verify_page_connection()

        print(f"[LOGIN] Login complete. Current URL: {page.url}")
        return (True, True)

    async def _verify_page_connection(self) -> bool:
        """Verify the page connection is still valid."""
        try:
            page = self._browser.page
            # Try to access page properties to verify connection
            url = page.url
            await page.title()
            print(f"[VERIFY] Page connection OK. URL: {url}")
            return True
        except Exception as e:
            print(f"[VERIFY] Page connection FAILED: {e}")
            raise RuntimeError(f"Page connection lost: {e}")

    async def _check_save_device_box(self) -> None:
        """Check the save device checkbox."""
        page = self._browser.page
        checkbox = page.locator("label").filter(has_text="Don't ask me again on this")
        await checkbox.check()

    # =========================================================================
    # Account Info
    # =========================================================================

    async def get_accounts_from_trade_page(self) -> list[str]:
        """
        Get account numbers from the trade page dropdown.
        More reliable than parsing the positions page.

        Returns:
            List of account numbers as strings.
        """
        try:
            # Verify page connection before navigation
            await self._verify_page_connection()

            page = self._browser.page

            # Navigate to trade page
            print("[DEBUG] Navigating to trade page...")
            await page.goto(URLs.TRADE, wait_until="domcontentloaded")
            await self._browser.wait_for_loading()
            await page.wait_for_timeout(3000)  # Wait longer for trade page

            print(f"[DEBUG] Trade page URL: {page.url}")

            # Try multiple selectors for account dropdown
            dropdown_selectors = [
                "#dest-acct-dropdown",
                "[data-testid='account-dropdown']",
                ".account-dropdown",
                "#account-selector",
                "button[aria-label*='account']",
                "button[aria-label*='Account']",
            ]

            account_dropdown = None
            for selector in dropdown_selectors:
                locator = page.locator(selector)
                count = await locator.count()
                print(f"[DEBUG] Selector '{selector}': {count} matches")
                if count > 0:
                    account_dropdown = locator.first
                    break

            if not account_dropdown:
                print("[DEBUG] No dropdown found, trying to find any dropdown button...")
                # Try looking for any dropdown that might contain account info
                buttons = page.locator("button")
                btn_count = await buttons.count()
                print(f"[DEBUG] Found {btn_count} buttons on page")

                # Look for a button with account-like text
                for i in range(min(btn_count, 20)):  # Check first 20 buttons
                    btn = buttons.nth(i)
                    try:
                        text = await btn.inner_text()
                        if any(x in text.lower() for x in ['account', 'individual', 'ira', 'brokerage']):
                            print(f"[DEBUG] Found potential account button: {text[:50]}")
                            account_dropdown = btn
                            break
                    except:
                        pass

            if not account_dropdown:
                print("[DEBUG] Could not find account dropdown")
                # Take a screenshot for debugging
                await page.screenshot(path="trade_page_debug.png")
                print("[DEBUG] Screenshot saved to trade_page_debug.png")
                return []

            # Click the dropdown
            print("[DEBUG] Clicking account dropdown...")
            await account_dropdown.click()
            await page.wait_for_timeout(1000)

            # Try multiple selectors for dropdown options
            option_selectors = [
                "#dest-acct-dropdown-menu li",
                "[role='option']",
                "[role='menuitem']",
                ".dropdown-item",
                "ul li",
            ]

            accounts = []
            for selector in option_selectors:
                options = page.locator(selector)
                count = await options.count()
                print(f"[DEBUG] Option selector '{selector}': {count} matches")
                if count > 0:
                    for i in range(count):
                        option = options.nth(i)
                        try:
                            text = await option.inner_text()
                            text = text.strip()
                            if text and len(text) > 3:
                                print(f"[DEBUG] Option {i}: {text[:60]}")
                                # Try to extract account number
                                import re
                                match = re.search(r'[A-Z]?\d{4,8}', text)
                                if match:
                                    accounts.append(match.group())
                                elif text not in accounts:
                                    accounts.append(text)
                        except:
                            pass
                    if accounts:
                        break

            # Close dropdown
            await page.keyboard.press("Escape")

            print(f"[DEBUG] Found {len(accounts)} accounts from trade dropdown: {accounts}")
            return accounts

        except Exception as e:
            print(f"Error getting accounts from trade page: {e}")
            traceback.print_exc()
            return []

    async def get_account_info(self) -> dict[str, Account]:
        """
        Get account information from positions page.

        Returns:
            Dict mapping account numbers to Account objects.
        """
        try:
            # Verify page connection before navigation
            await self._verify_page_connection()

            page = self._browser.page
            print("[ACCOUNT] Navigating to positions page...")
            await page.goto(URLs.POSITIONS, wait_until="domcontentloaded")
            await self._browser.wait_for_loading()
            await page.wait_for_timeout(2000)

            accounts: dict[str, Account] = {}

            # Get all account rows (AG Grid)
            account_rows = page.locator(Selectors.ACCOUNT_CONTAINER)
            acc_count = await account_rows.count()

            for i in range(acc_count):
                acc_row = account_rows.nth(i)

                try:
                    acc_num_elem = acc_row.locator(Selectors.ACCOUNT_NUMBER).first
                    acc_num = await acc_num_elem.inner_text()
                    acc_num = acc_num.strip()
                except Exception:
                    continue

                stocks = []
                total_value = 0.0

                position_rows = page.locator(Selectors.POSITION_ROW)
                pos_count = await position_rows.count()

                for j in range(pos_count):
                    row = position_rows.nth(j)
                    try:
                        ticker_elem = row.locator(Selectors.POSITION_TICKER).first
                        ticker = await ticker_elem.inner_text()
                        ticker = ticker.strip()

                        if not ticker or ticker == "":
                            continue

                        qty_elem = row.locator(Selectors.POSITION_QUANTITY).first
                        qty_text = await qty_elem.inner_text()
                        qty = float(qty_text.replace(",", "").strip())

                        price_elem = row.locator(Selectors.POSITION_PRICE).first
                        price_text = await price_elem.inner_text()
                        price = float(price_text.replace("$", "").replace(",", "").strip())

                        value_elem = row.locator(Selectors.POSITION_VALUE).first
                        value_text = await value_elem.inner_text()
                        value = float(value_text.replace("$", "").replace(",", "").strip())

                        stocks.append(Stock(
                            ticker=ticker,
                            quantity=qty,
                            last_price=price,
                            value=value,
                        ))
                        total_value += value

                    except Exception:
                        continue

                accounts[acc_num] = Account(
                    account_number=acc_num,
                    balance=total_value,
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
    ) -> tuple[bool, Optional[str], str]:
        """
        Execute a trade with human-like behavior.

        Args:
            stock: Ticker symbol
            quantity: Number of shares
            action: "buy" or "sell"
            account: Account number
            dry: If True, preview only (don't submit)
            limit_price: Optional limit price

        Returns:
            Tuple of (success, error_message, alert_code)
        """
        try:
            # Verify page connection before navigation
            await self._verify_page_connection()

            page = self._browser.page

            # Navigate to trade page
            print(f"[TRADE] Navigating to trade page for {action} {quantity} {stock}...")
            await page.goto(URLs.TRADE, wait_until="domcontentloaded")
            await self._browser.wait_for_loading()
            await page_load_delay()

            # Random mouse movement
            await random_mouse_movement(page, count=1)

            # Select account
            account_dropdown = page.locator(Selectors.ACCOUNT_DROPDOWN)
            await human_click(page, account_dropdown, wait_after=False)
            await minor_delay()
            account_option = page.get_by_text(account, exact=False).first
            await human_click(page, account_option)

            # Enter symbol
            symbol_input = page.locator(Selectors.SYMBOL_INPUT)
            await human_fill(page, symbol_input, stock.upper())
            await action_delay()

            # Press Tab to confirm symbol and load quote
            await symbol_input.press("Tab")
            await self._browser.wait_for_loading()
            await action_delay()

            # Select action (Buy/Sell)
            action_dropdown = page.locator(Selectors.ACTION_DROPDOWN)
            await human_click(page, action_dropdown, wait_after=False)
            await minor_delay()
            action_text = "Buy" if action.lower() == "buy" else "Sell"
            await human_click(page, page.get_by_text(action_text, exact=True))

            # Enter quantity
            qty_input = page.locator(Selectors.QUANTITY_INPUT)
            await human_fill(page, qty_input, str(int(quantity)))

            # Set order type if limit
            if limit_price:
                order_type_dropdown = page.locator(Selectors.ORDER_TYPE_DROPDOWN)
                await human_click(page, order_type_dropdown, wait_after=False)
                await minor_delay()
                await human_click(page, page.get_by_text("Limit", exact=True))
                limit_input = page.locator(Selectors.LIMIT_PRICE_INPUT)
                await human_fill(page, limit_input, str(limit_price))

            # Think before previewing
            await think_delay()

            # Preview order
            preview_btn = page.get_by_role("button", name="Preview order")
            await human_click(page, preview_btn)
            await self._browser.wait_for_loading()
            await page_load_delay()

            # Check for errors
            error_elem = page.locator(Selectors.ORDER_ERROR)
            if await error_elem.count() > 0 and await error_elem.first.is_visible():
                error_text = await error_elem.first.inner_text()
                alert = classify_error(error_text)
                return (False, error_text, alert.value)

            if dry:
                return (True, None, TradeAlert.SUCCESS.value)

            # Submit order
            await submit_delay()

            submit_btn = page.get_by_role("button", name="Place order")
            await human_click(page, submit_btn)
            await self._browser.wait_for_loading()
            await page_load_delay()

            # Check for confirmation
            confirm = page.locator(Selectors.ORDER_CONFIRMATION)
            if await confirm.count() > 0 and await confirm.first.is_visible():
                return (True, None, TradeAlert.SUCCESS.value)

            # Check for success message
            success_text = page.get_by_text("Order received", exact=False)
            if await success_text.count() > 0:
                return (True, None, TradeAlert.SUCCESS.value)

            return (False, "Order may not have been placed", TradeAlert.UNKNOWN.value)

        except PatchrightTimeoutError as e:
            print(f"Transaction timeout: {e}")
            traceback.print_exc()
            return (False, str(e), TradeAlert.TIMEOUT.value)
        except Exception as e:
            print(f"Transaction error: {e}")
            traceback.print_exc()
            alert = classify_error(str(e))
            return (False, str(e), alert.value)
