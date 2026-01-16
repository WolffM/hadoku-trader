"""
Browser management for Fidelity API.

Handles Playwright browser initialization, stealth settings, and page management.
"""

import os
import json
from typing import Optional

from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright_stealth import Stealth

from .selectors import Selectors, Timeouts


class FidelityBrowser:
    """
    Manages the Playwright browser instance for Fidelity automation.

    Handles browser lifecycle, stealth settings, and state persistence.
    """

    def __init__(
        self,
        headless: bool = True,
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
        """
        Initialize the browser manager.

        Args:
            headless: Run browser in headless mode.
            save_state: Save cookies and session state to JSON file.
            profile_path: Directory to store session data.
            title: Optional title for unique session files (e.g., Fidelity_title.json).
            debug: Enable debug tracing with screenshots.
        """
        self.headless = headless
        self.save_state = save_state
        self.profile_path = profile_path
        self.title = title
        self.debug = debug

        self._playwright = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._storage_path: Optional[str] = None

        self._stealth = Stealth(
            navigator_languages=True,
            navigator_user_agent=True,
            navigator_vendor=True,
        )

        self._initialize()

    def _initialize(self) -> None:
        """Initialize the browser, context, and page."""
        self._playwright = sync_playwright().start()

        # Set up storage path for cookies
        if self.save_state:
            self._storage_path = self._get_storage_path()
            self._ensure_storage_file()

        # Launch browser
        self._browser = self._playwright.firefox.launch(
            headless=self.headless,
            args=["--disable-webgl", "--disable-software-rasterizer"],
        )

        # Create context with optional storage state
        self._context = self._browser.new_context(
            storage_state=self._storage_path if self.save_state else None
        )

        # Enable debug tracing
        if self.debug:
            self._context.tracing.start(
                name="fidelity_trace",
                screenshots=True,
                snapshots=True,
            )

        # Create page and apply stealth
        self._page = self._context.new_page()
        self._stealth.apply_stealth_sync(self._page)

    def _get_storage_path(self) -> str:
        """Get the path for the storage state file."""
        base_path = os.path.abspath(self.profile_path)
        if self.title:
            filename = f"Fidelity_{self.title}.json"
        else:
            filename = "Fidelity.json"
        return os.path.join(base_path, filename)

    def _ensure_storage_file(self) -> None:
        """Ensure the storage file exists."""
        if self._storage_path and not os.path.exists(self._storage_path):
            os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
            with open(self._storage_path, "w") as f:
                json.dump({}, f)

    @property
    def page(self) -> Page:
        """Get the current page instance."""
        if self._page is None:
            raise RuntimeError("Browser not initialized")
        return self._page

    @property
    def context(self) -> BrowserContext:
        """Get the current browser context."""
        if self._context is None:
            raise RuntimeError("Browser not initialized")
        return self._context

    def goto(self, url: str, wait_for_load: bool = True) -> None:
        """
        Navigate to a URL.

        Args:
            url: The URL to navigate to.
            wait_for_load: Wait for page load state.
        """
        if wait_for_load:
            self.page.wait_for_load_state(state="load")
        self.page.goto(url)

    def wait_for_loading(self, timeout: int = Timeouts.DEFAULT) -> None:
        """
        Wait for all known Fidelity loading indicators to disappear.

        Args:
            timeout: Maximum time to wait in milliseconds.
        """
        loading_selectors = [
            Selectors.LOADING_SPINNER_1,
            Selectors.LOADING_SPINNER_2,
            Selectors.LOADING_SPINNER_3,
            Selectors.LOADING_SPINNER_4,
        ]

        for selector in loading_selectors:
            locator = self.page.locator(selector).first
            locator.wait_for(timeout=timeout, state="hidden")

    def save_storage_state(self) -> None:
        """Save the current storage state to file."""
        if self.save_state and self._storage_path:
            storage_state = self._context.storage_state()
            with open(self._storage_path, "w") as f:
                json.dump(storage_state, f)

    def close(self) -> None:
        """Close the browser and clean up resources."""
        try:
            # Save state before closing
            self.save_storage_state()

            # Save debug traces
            if self.debug:
                trace_name = f"fidelity_trace{self.title or ''}.zip"
                self._context.tracing.stop(path=f"./{trace_name}")

            # Close in order: page -> context -> browser -> playwright
            if self._context:
                self._context.close()
            if self._browser:
                self._browser.close()
            if self._playwright:
                self._playwright.stop()
        finally:
            self._page = None
            self._context = None
            self._browser = None
            self._playwright = None

    def __enter__(self) -> "FidelityBrowser":
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit."""
        self.close()
