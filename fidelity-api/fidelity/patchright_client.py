"""
Patchright-based Fidelity Client for use in async contexts.

Uses Patchright (patched Playwright) to avoid CDP detection that triggers
Fidelity's bot detection. This is a drop-in replacement for FidelityClientAsync.

Key differences:
- Uses Chromium instead of Firefox
- Patches CDP at protocol level to avoid detection
- No need for playwright-stealth (Patchright handles it)
"""

import os
import time
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

            # Navigate to login page
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

            # Detect page state by CONTENT, not URL.
            # Fidelity changes URLs without notice (login/full-page → signin/retail).
            page_state = await self._detect_page_state(page)
            print(f"[LOGIN] Page state: {page_state} | URL: {page.url}")

            if page_state == "error":
                return (False, False)
            if page_state == "logged_in":
                print("[LOGIN] Already logged in (session restored)")
                await page.wait_for_timeout(2000)
                await self._verify_page_connection()
                return (True, True)
            if page_state == "2fa":
                if totp_secret == "NA":
                    totp_secret = None
                return await self._handle_2fa(totp_secret, save_device)

            # Unknown state — screenshot and fail loudly
            print(f"[LOGIN] Unknown page state after login submission")
            print(f"[LOGIN] Title: {await page.title()}")
            await page.screenshot(path="login_unknown_state.png")
            return (False, False)

        except PatchrightTimeoutError:
            traceback.print_exc()
            return (False, False)
        except Exception as e:
            print(f"Login error: {e}")
            traceback.print_exc()
            return (False, False)

    async def _find_totp_input(self):
        """Find the TOTP code input field using multiple strategies.

        Fidelity periodically changes the attributes on this field, so we
        try several selectors in priority order and log what we find.
        """
        page = self._browser.page

        # Strategies in priority order — most specific first
        strategies = [
            ("maxlength=6", page.locator('input[maxlength="6"]')),
            ("placeholder XXXXXX", page.get_by_placeholder(Selectors.TOTP_INPUT)),
            ("inputmode=numeric", page.locator('input[inputmode="numeric"]')),
            ("type=tel", page.locator('input[type="tel"]')),
            ("aria-label code", page.locator('input[aria-label*="code" i]')),
            ("aria-label security", page.locator('input[aria-label*="security" i]')),
            ("type=text visible", page.locator('input[type="text"]:visible')),
        ]

        for name, locator in strategies:
            count = await locator.count()
            if count > 0 and await locator.first.is_visible():
                print(f"[2FA] Found TOTP input via '{name}' ({count} match(es))")
                return locator.first
            elif count > 0:
                print(f"[2FA] Selector '{name}' matched {count} but not visible")

        return None

    async def _handle_2fa(
        self,
        totp_secret: Optional[str],
        save_device: bool,
    ) -> tuple[bool, bool]:
        """Handle 2FA flow with human-like behavior."""
        page = self._browser.page

        await self._browser.wait_for_loading()
        await think_delay()

        print(f"[2FA] Current URL: {page.url}")
        print(f"[2FA] Page title: {await page.title()}")

        # Wait for 2FA page to fully render
        await page.wait_for_timeout(3000)

        # Dump visible inputs for debugging
        all_inputs = page.locator("input")
        input_count = await all_inputs.count()
        print(f"[2FA] Total input fields on page: {input_count}")
        for i in range(min(input_count, 15)):
            inp = all_inputs.nth(i)
            try:
                attrs = await inp.evaluate(
                    "el => ({type: el.type, maxlength: el.maxLength, placeholder: el.placeholder, "
                    "name: el.name, id: el.id, inputmode: el.inputMode, "
                    "ariaLabel: el.getAttribute('aria-label'), visible: el.offsetParent !== null})"
                )
                print(f"[2FA]   input[{i}]: {attrs}")
            except Exception:
                pass

        # Try to find the TOTP input
        totp_field = await self._find_totp_input()

        if totp_field:
            if totp_secret:
                return await self._complete_totp_login(totp_secret, save_device, totp_field)
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
            # Re-search for TOTP input after SMS flow
            totp_field = await self._find_totp_input()
            if totp_field:
                return (True, False)

        print("[2FA] ERROR: Could not find TOTP or SMS option")
        print("[2FA] Taking screenshot for debugging...")
        await page.screenshot(path="2fa_debug_patchright.png")
        return (False, False)

    async def _complete_totp_login(
        self,
        totp_secret: str,
        save_device: bool,
        totp_field=None,
    ) -> tuple[bool, bool]:
        """Complete login with TOTP using human-like behavior."""
        page = self._browser.page

        # Simulate getting code from authenticator app
        await think_delay()

        code = pyotp.TOTP(totp_secret).now()

        # Use the already-found field, or re-search as fallback
        if totp_field is None:
            totp_field = await self._find_totp_input()
        if totp_field is None:
            print("[2FA] Cannot find TOTP input for code entry")
            return (False, False)

        print(f"[2FA] Entering TOTP code...")
        # Type the code like a human
        await human_type(page, totp_field, code)

        # DIAGNOSTIC: always dump the 2FA page DOM + screenshot right after
        # the TOTP code is entered and before Continue is clicked. This is
        # the exact moment the "Remember this device" checkbox is visible.
        # Captured to disk so we can fix _check_save_device_box()'s stale
        # selector offline without risking another broken login attempt
        # that trips Fidelity's "Sorry, we can't complete this action"
        # error state. Runs regardless of save_device value — no DOM
        # mutation, read-only.
        try:
            dump_ts = int(time.time())
            dump_base = os.path.join(os.getcwd(), f"2fa-debug-{dump_ts}")
            html = await page.content()
            with open(dump_base + ".html", "w", encoding="utf-8") as f:
                f.write(html)
            print(f"[2FA-DEBUG] DOM dumped to {dump_base}.html ({len(html)} bytes)")
            try:
                await page.screenshot(path=dump_base + ".png", full_page=True)
                print(f"[2FA-DEBUG] Screenshot saved to {dump_base}.png")
            except Exception as se:
                print(f"[2FA-DEBUG] screenshot failed (non-fatal): {se!r}")
        except Exception as de:
            print(f"[2FA-DEBUG] DOM dump failed (non-fatal): {de!r}")

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

        # Detect post-TOTP page state — don't rely on URL patterns
        post_totp_state = await self._detect_page_state(page)
        print(f"[LOGIN] Post-TOTP state: {post_totp_state}")

        if post_totp_state == "error":
            print("[LOGIN] Error after TOTP submission")
            return (False, False)
        if post_totp_state == "2fa":
            print("[LOGIN] Still on 2FA page after TOTP — code may have been rejected")
            return (False, False)

        # Navigate to summary page if we're not already there
        if post_totp_state != "logged_in":
            print(f"[LOGIN] Not on portfolio yet ({page.url}), navigating to summary...")
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

    async def _detect_page_state(self, page) -> str:
        """Detect current page state by content, not URL.

        Returns one of: 'logged_in', '2fa', 'error', 'unknown'.

        This is the key robustness measure — Fidelity can change URLs at
        any time, but the page content (portfolio elements, TOTP inputs,
        error messages) is more stable.
        """
        # Check for error messages first (bot detection, wrong creds)
        error_indicators = [
            page.locator(".pvd-inline-alert--error"),
            page.locator("[role='alert']"),
            page.get_by_text("Sorry, we can't complete this action", exact=False),
            page.get_by_text("please try again", exact=False),
            page.get_by_text("unable to log in", exact=False),
        ]
        for err in error_indicators:
            try:
                if await err.count() > 0 and await err.first.is_visible():
                    error_text = await err.first.inner_text()
                    print(f"[LOGIN] BLOCKED: {error_text.strip()[:200]}")
                    return "error"
            except Exception:
                pass

        # Check for logged-in state (portfolio page elements)
        logged_in_indicators = [
            "portfolio" in page.url,
            "summary" in page.url,
            await page.locator(".posweb-row-account").count() > 0,
            await page.get_by_text("Total", exact=False).count() > 0
            and "portfolio" in page.url,
        ]
        if any(logged_in_indicators):
            return "logged_in"

        # Check for 2FA state (TOTP input, authenticator text)
        totp_field = await self._find_totp_input()
        if totp_field:
            return "2fa"

        # Also check for 2FA page text without visible input yet
        twofa_text_indicators = [
            page.get_by_text("Enter the code", exact=False),
            page.get_by_text("authenticator app", exact=False),
            page.get_by_text("security code", exact=False),
            page.get_by_text("Two-factor", exact=False),
            page.get_by_text("Text me the code", exact=False),
            page.get_by_text("Try another way", exact=False),
        ]
        for indicator in twofa_text_indicators:
            try:
                if await indicator.count() > 0 and await indicator.first.is_visible():
                    return "2fa"
            except Exception:
                pass

        return "unknown"

    async def _check_save_device_box(self) -> None:
        """
        Check the 'Don't ask me again on this device' checkbox if present.

        The real input has id=dom-trust-device-checkbox but is visually
        hidden by Fidelity's pvd-checkbox CSS, so Playwright's default
        actionability checks reject it. We click the label instead, which
        is the visible element users actually click. Best-effort no-op if
        the element isn't on the page.
        """
        page = self._browser.page
        try:
            label = page.locator('label[for="dom-trust-device-checkbox"]')
            if await label.count() == 0:
                print("[2FA] save-device label not found — skipping (login will still proceed)")
                return
            await label.first.click(timeout=5000)
            print("[2FA] save-device checkbox checked via label click")
        except Exception as e:
            print(f"[2FA] save-device checkbox interaction failed: {e!r} — continuing login")

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

    async def get_account_info(
        self, target_account: Optional[str] = None
    ) -> dict[str, Account]:
        """
        Get account information from the positions page.

        If target_account is provided, navigate to the positions view scoped
        to that single account (Fidelity accepts ?ACCOUNT=<num> on the
        positions URL — same URL pattern their own UI uses when you click
        an account from the left rail). This is both faster and more
        reliable: the all-accounts view has 5 accounts worth of rows to
        hydrate and AG Grid often doesn't finish populating on cold start
        within a reasonable timeout. Scoping to one account means a few
        dozen rows at most.

        AG Grid splits each row across two containers — pinned-left for
        the ticker, center for all numeric data — and rows are correlated
        by their shared `row-id` attribute. The scrape is a single
        `page.evaluate()` that walks the DOM once, immune to the split.

        Returns:
            Dict mapping account numbers to Account objects.
        """
        try:
            await self._verify_page_connection()

            page = self._browser.page
            if target_account:
                url = f"{URLs.POSITIONS}?ACCOUNT={target_account}"
                print(f"[ACCOUNT] Navigating to positions scoped to {target_account}...")
            else:
                url = URLs.POSITIONS
                print("[ACCOUNT] Navigating to positions page (all accounts)...")
            await page.goto(url, wait_until="domcontentloaded")
            # Deliberately NOT calling self._browser.wait_for_loading() here.
            # That helper iterates 4 Fidelity spinner selectors with a 30s
            # timeout each (up to 2 minutes of silent blocking) and at least
            # one of those spinners on the positions page gets stuck in
            # "visible" state from AG Grid's own loading overlay — even after
            # the page is fully interactive to a human observer. The row-
            # attach wait below is a more reliable readiness signal: it
            # unblocks as soon as actual data is in the DOM.
            # AG Grid populates rows asynchronously via XHR after DOMContentLoaded.
            # A fixed 2s wait was fine on a warm browser but too short on cold-start
            # where network + hydration stack up. Wait for at least one account row
            # to actually appear in the DOM before running the scrape. 30s timeout
            # covers both cold and warm cases; ticks quickly on a warm page.
            try:
                await page.locator(".posweb-row-account").first.wait_for(
                    state="attached", timeout=30_000
                )
            except Exception as e:
                # If rows don't appear, dump a diagnostic so we can see WHY
                # (page URL, title, visible content) instead of returning empty.
                diag = await page.evaluate(r"""() => ({
                    url: document.location.href,
                    title: document.title,
                    bodyTextLen: (document.body && document.body.innerText || '').length,
                    agRows: document.querySelectorAll('.ag-row').length,
                    postebRowAccount: document.querySelectorAll('.posweb-row-account').length,
                    pinnedContainer: !!document.querySelector('.ag-pinned-left-cols-container'),
                    centerContainer: !!document.querySelector('.ag-center-cols-container'),
                })""")
                raise RuntimeError(
                    f"positions page never rendered account rows within 30s: "
                    f"{e!r} | diagnostic={diag}"
                )

            scrape_js = r"""() => {
                const parseMoney = (s) => {
                    if (!s) return null;
                    const cleaned = s.replace(/[$,\s]/g, '').trim();
                    if (!cleaned) return null;
                    const n = parseFloat(cleaned);
                    return isNaN(n) ? null : n;
                };

                // Walk pinned-side rows in DOM order. Account rows act as group
                // headers; position rows that follow belong to the last seen
                // account until the next account row appears.
                const pinned = document.querySelector('.ag-pinned-left-cols-container');
                if (!pinned) {
                    return { error: 'pinned-left container not found', accounts: [] };
                }
                const centerContainer = document.querySelector('.ag-center-cols-container');
                if (!centerContainer) {
                    return { error: 'center container not found', accounts: [] };
                }

                const allRows = Array.from(
                    pinned.querySelectorAll('.posweb-row-account, .posweb-row-position')
                );

                const accounts = [];
                let current = null;

                for (const row of allRows) {
                    if (row.classList.contains('posweb-row-account')) {
                        const accNumEl = row.querySelector('.posweb-cell-account_secondary');
                        const accNameEl = row.querySelector('.posweb-cell-account_primary');
                        current = {
                            account_number: accNumEl ? accNumEl.innerText.trim() : null,
                            nickname: accNameEl ? accNameEl.innerText.trim() : null,
                            positions: [],
                        };
                        if (current.account_number) {
                            accounts.push(current);
                        }
                        continue;
                    }
                    if (!current) continue;

                    const rowId = row.getAttribute('row-id');
                    if (!rowId) continue;

                    // Ticker lives inside the pinned row
                    const tickerEl = row.querySelector(
                        '.posweb-cell-symbol-name_container span'
                    );
                    let ticker = tickerEl ? tickerEl.innerText.trim() : '';
                    // Cash / money-market rows don't have a real ticker — they
                    // often show a description instead. Detect and mark.
                    const descEl = row.querySelector('.posweb-cell-symbol-description');
                    const description = descEl ? descEl.innerText.trim() : '';
                    const isCash = /cash|money market|held in/i.test(description)
                        || /^cash$/i.test(ticker);
                    if (!ticker && isCash) ticker = 'CASH';
                    if (!ticker) continue;

                    // Data cells live in a sibling <div row-id="..."> in the
                    // center container.
                    const centerRow = centerContainer.querySelector(
                        `[row-id="${rowId}"]`
                    );
                    if (!centerRow) continue;

                    const pickText = (sel) => {
                        const el = centerRow.querySelector(sel);
                        return el ? el.innerText : null;
                    };

                    const qty = parseMoney(pickText('.posweb-cell-quantity_value'))
                        ?? parseMoney(pickText('.posweb-cell-quantity'));
                    const price = parseMoney(pickText('.posweb-cell-last_price'));
                    const value = parseMoney(pickText('.posweb-cell-current_value'));
                    const costBasis = parseMoney(pickText('.posweb-cell-cost_basis'));

                    current.positions.push({
                        ticker: ticker,
                        quantity: qty,
                        last_price: price,
                        value: value,
                        cost_basis: costBasis,
                        is_cash: isCash,
                        row_id: rowId,
                    });
                }

                return { accounts: accounts };
            }"""

            scrape = await page.evaluate(scrape_js)
            if scrape.get("error"):
                # Propagate the specific scrape error up so the caller sees
                # what went wrong (previously this was swallowed to an empty
                # dict and re-surfaced as a generic "browser scrape likely
                # failed" from the service layer).
                print(f"[ACCOUNT] scrape error: {scrape['error']}")
                raise RuntimeError(f"positions scrape JS reported: {scrape['error']}")

            raw_accounts_list = scrape.get("accounts", [])
            if not raw_accounts_list:
                # The scrape JS ran, containers existed, but no account rows
                # were walked. Dump a diagnostic so we can see why.
                diag = await page.evaluate(r"""() => ({
                    url: document.location.href,
                    title: document.title,
                    postebRowAccount: document.querySelectorAll('.posweb-row-account').length,
                    postebRowPosition: document.querySelectorAll('.posweb-row-position').length,
                    agRows: document.querySelectorAll('.ag-row').length,
                })""")
                raise RuntimeError(
                    f"positions scrape found no accounts. diagnostic={diag}"
                )

            accounts: dict[str, Account] = {}
            for raw_acc in raw_accounts_list:
                acc_num = raw_acc.get("account_number")
                if not acc_num:
                    continue

                stocks: list[Stock] = []
                total_value = 0.0
                for p in raw_acc.get("positions", []):
                    try:
                        qty = float(p.get("quantity") or 0)
                        price = float(p.get("last_price") or 0)
                        value = float(p.get("value") or 0)
                        cost_basis = p.get("cost_basis")
                        cost_basis_f = float(cost_basis) if cost_basis is not None else None
                    except (TypeError, ValueError) as e:
                        print(f"[ACCOUNT] skipping malformed row for {p.get('ticker')}: {e}")
                        continue

                    stocks.append(Stock(
                        ticker=p.get("ticker") or "UNKNOWN",
                        quantity=qty,
                        last_price=price,
                        value=value,
                        cost_basis=cost_basis_f,
                        is_cash=bool(p.get("is_cash", False)),
                    ))
                    total_value += value

                accounts[acc_num] = Account(
                    account_number=acc_num,
                    nickname=raw_acc.get("nickname"),
                    balance=total_value,
                    stocks=stocks,
                )

            print(f"[ACCOUNT] scraped {len(accounts)} account(s), "
                  f"{sum(len(a.stocks) for a in accounts.values())} position(s) total")
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

            # Enter quantity. Fidelity's equity order form accepts fractional
            # share quantities directly in the #eqt-shared-quantity input
            # (verified via DOM probe: 0.5 and 2.5 stick after input+blur).
            # Earlier str(int(quantity)) silently truncated decimals, leaving
            # the worker thinking it bought 2.617 shares while Fidelity only
            # executed 2. Format with up to 4 decimals and strip trailing
            # zeros so whole-share orders send "2" (not "2.0000") and
            # fractional orders keep their precision.
            qty_str = f"{float(quantity):.4f}".rstrip("0").rstrip(".")
            qty_input = page.locator(Selectors.QUANTITY_INPUT)
            await human_fill(page, qty_input, qty_str)

            # Always use market order
            order_type_dropdown = page.locator(Selectors.ORDER_TYPE_DROPDOWN)
            await human_click(page, order_type_dropdown, wait_after=False)
            await minor_delay()
            await human_click(page, page.get_by_role("option", name="Market", exact=True))

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
