"""
Authentication module for Fidelity API.

Handles login, 2FA, and session management.
"""

import traceback
from typing import Optional

import pyotp
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors, Timeouts
from .models import LoginResult
from .exceptions import (
    LoginError,
    TwoFactorError,
    TOTPRequiredError,
)


class FidelityAuth:
    """Handles Fidelity authentication."""

    def __init__(self, browser: FidelityBrowser) -> None:
        """
        Initialize authentication handler.

        Args:
            browser: FidelityBrowser instance to use for authentication.
        """
        self.browser = browser

    def login(
        self,
        username: str,
        password: str,
        totp_secret: Optional[str] = None,
        save_device: bool = False,
    ) -> LoginResult:
        """
        Log into Fidelity.

        If totp_secret is provided, fully automated TOTP-based login is attempted.
        If not, the function will initiate SMS 2FA and return (True, False) to
        indicate that login_2fa() must be called with the code.

        Args:
            username: Fidelity username.
            password: Fidelity password.
            totp_secret: TOTP secret for authenticator app (optional).
            save_device: Whether to save device to skip 2FA in future.

        Returns:
            LoginResult with step1_success and fully_logged_in flags.

        Raises:
            LoginError: If login fails.
            TOTPRequiredError: If TOTP is required but not provided.
        """
        try:
            page = self.browser.page

            # Navigate to login page (twice for reliability)
            page.goto(URLs.LOGIN)
            page.wait_for_timeout(5000)
            page.goto(URLs.LOGIN)

            # Fill credentials
            page.get_by_label("Username", exact=True).click()
            page.get_by_label("Username", exact=True).fill(username)
            page.get_by_label("Password", exact=True).click()
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_role("button", name="Log in").click()

            # Wait for initial load
            self.browser.wait_for_loading()
            page.wait_for_timeout(1000)
            self.browser.wait_for_loading()

            # Check if we landed on summary page (no 2FA needed)
            if "summary" in page.url:
                return LoginResult(step1_success=True, fully_logged_in=True)

            # Normalize TOTP secret
            if totp_secret == "NA":
                totp_secret = None

            # Handle 2FA page
            if "login" in page.url:
                return self._handle_2fa(totp_secret, save_device)

            raise LoginError("Unexpected page after login attempt")

        except PlaywrightTimeoutError:
            traceback.print_exc()
            return LoginResult(step1_success=False, fully_logged_in=False)
        except Exception as e:
            print(f"Login error: {e}")
            traceback.print_exc()
            return LoginResult(step1_success=False, fully_logged_in=False)

    def _handle_2fa(
        self,
        totp_secret: Optional[str],
        save_device: bool,
    ) -> LoginResult:
        """Handle 2FA flow after initial login."""
        page = self.browser.page

        self.browser.wait_for_loading()
        widget = page.locator(Selectors.LOGIN_WIDGET).first
        widget.wait_for(timeout=Timeouts.SHORT, state="visible")

        # Check for TOTP prompt
        totp_heading = page.get_by_role("heading", name="Enter the code from your")
        if totp_secret and totp_heading.is_visible():
            return self._complete_totp_login(totp_secret, save_device)

        # TOTP required but not provided
        if page.get_by_text(
            "Enter the code from your authenticator app This security code will confirm the"
        ).is_visible():
            raise TOTPRequiredError(
                "Fidelity requires authenticator app code but TOTP secret not provided"
            )

        # Handle app push notification page
        if page.get_by_role("link", name="Try another way").is_visible():
            if save_device:
                self._check_save_device_box()
            page.get_by_role("link", name="Try another way").click()

        # Fall back to SMS
        page.get_by_role("button", name="Text me the code").click()
        page.get_by_placeholder(Selectors.TOTP_INPUT).click()

        return LoginResult(step1_success=True, fully_logged_in=False)

    def _complete_totp_login(
        self,
        totp_secret: str,
        save_device: bool,
    ) -> LoginResult:
        """Complete login using TOTP code."""
        page = self.browser.page

        # Generate and enter TOTP code
        code = pyotp.TOTP(totp_secret).now()
        page.get_by_placeholder(Selectors.TOTP_INPUT).click()
        page.get_by_placeholder(Selectors.TOTP_INPUT).fill(code)

        # Optionally save device
        if save_device:
            self._check_save_device_box()

        # Submit
        page.get_by_role("button", name="Continue").click()
        self.browser.wait_for_loading()

        # Wait for summary page
        page.wait_for_url(URLs.SUMMARY, timeout=Timeouts.LOGIN)

        return LoginResult(step1_success=True, fully_logged_in=True)

    def _check_save_device_box(self) -> None:
        """Check the 'Don't ask me again' checkbox."""
        page = self.browser.page
        checkbox = page.locator("label").filter(has_text="Don't ask me again on this")
        checkbox.check()
        if not checkbox.is_checked():
            raise TwoFactorError("Failed to check 'Don't ask me again' box")

    def login_2fa(self, code: str, save_device: bool = True) -> bool:
        """
        Complete 2FA login with SMS code.

        Call this after login() returns (True, False).

        Args:
            code: The SMS verification code.
            save_device: Whether to save device to skip 2FA in future.

        Returns:
            True if login successful, False otherwise.
        """
        try:
            page = self.browser.page

            page.get_by_placeholder(Selectors.TOTP_INPUT).fill(code)

            if save_device:
                self._check_save_device_box()

            page.get_by_role("button", name="Submit").click()
            page.wait_for_url(URLs.SUMMARY, timeout=Timeouts.SHORT)

            return True

        except PlaywrightTimeoutError:
            print("Timeout waiting for 2FA completion")
            return False
        except Exception as e:
            print(f"2FA error: {e}")
            traceback.print_exc()
            return False
