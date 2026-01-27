"""
Patchright Browser management for Fidelity API.

Uses Patchright (patched Playwright) to avoid CDP detection that triggers
Fidelity's bot detection. Chromium-only implementation.

Key differences from standard Playwright:
- Patches Chrome DevTools Protocol to avoid detection
- Disables Runtime.enable which is a common detection vector
- Removes automation flags at protocol level
"""

import os
import json
from typing import Optional

from patchright.async_api import (
    async_playwright,
    Page as AsyncPage,
    Browser as AsyncBrowser,
    BrowserContext as AsyncBrowserContext,
)

from .selectors import Selectors, Timeouts


class PatchrightBrowserAsync:
    """
    Async browser using Patchright for CDP-level stealth.

    Patchright patches the Chrome DevTools Protocol to avoid detection
    that standard Playwright triggers. This is necessary because Fidelity
    detects automation at the protocol level, not just via navigator properties.

    Usage:
        async with PatchrightBrowserAsync() as browser:
            page = browser.page
            await page.goto("https://fidelity.com")
    """

    def __init__(
        self,
        headless: bool = False,  # Patchright works best with headless=False
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
        # Patchright recommends headless=False for best stealth
        # Force headed mode unless explicitly overridden
        self.headless = headless
        self.save_state = save_state
        self.profile_path = profile_path
        self.title = title
        self.debug = debug

        self._playwright = None
        self._browser: Optional[AsyncBrowser] = None
        self._context: Optional[AsyncBrowserContext] = None
        self._page: Optional[AsyncPage] = None
        self._storage_path: Optional[str] = None
        self._initialized = False

    async def initialize(self) -> "PatchrightBrowserAsync":
        """Initialize the browser asynchronously. Must be called before use."""
        if self._initialized:
            return self

        self._playwright = await async_playwright().start()

        if self.save_state:
            self._storage_path = self._get_storage_path()
            self._ensure_storage_file()

        # Patchright recommends:
        # - channel="chrome" for best undetectability (uses system Chrome)
        # - headless=False (headed mode is more stealthy)
        # - no_viewport=True to avoid viewport detection
        self._browser = await self._playwright.chromium.launch(
            headless=self.headless,
            channel="chrome",  # Use system Chrome for better stealth
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ],
        )

        # Create context with realistic settings
        context_options = {
            "no_viewport": True,  # Patchright recommendation for stealth
            "user_agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "locale": "en-US",
            "timezone_id": "America/New_York",
        }

        if self.save_state and self._storage_path and os.path.exists(self._storage_path):
            # Check if storage file has content
            try:
                with open(self._storage_path, "r") as f:
                    storage_data = json.load(f)
                if storage_data:  # Only use if not empty
                    context_options["storage_state"] = self._storage_path
            except (json.JSONDecodeError, KeyError):
                pass  # Skip invalid storage files

        self._context = await self._browser.new_context(**context_options)

        if self.debug:
            await self._context.tracing.start(
                name="fidelity_patchright_trace",
                screenshots=True,
                snapshots=True,
            )

        self._page = await self._context.new_page()
        self._initialized = True
        return self

    def _get_storage_path(self) -> str:
        base_path = os.path.abspath(self.profile_path)
        filename = f"Fidelity_Patchright_{self.title}.json" if self.title else "Fidelity_Patchright.json"
        return os.path.join(base_path, filename)

    def _ensure_storage_file(self) -> None:
        if self._storage_path and not os.path.exists(self._storage_path):
            os.makedirs(os.path.dirname(self._storage_path) or ".", exist_ok=True)
            with open(self._storage_path, "w") as f:
                json.dump({}, f)

    @property
    def page(self) -> AsyncPage:
        if self._page is None:
            raise RuntimeError("Browser not initialized. Call await browser.initialize() first.")
        return self._page

    @property
    def context(self) -> AsyncBrowserContext:
        if self._context is None:
            raise RuntimeError("Browser not initialized. Call await browser.initialize() first.")
        return self._context

    async def goto(self, url: str, wait_for_load: bool = True) -> None:
        if wait_for_load:
            await self.page.wait_for_load_state(state="load")
        await self.page.goto(url)

    async def wait_for_loading(self, timeout: int = Timeouts.DEFAULT) -> None:
        """Wait for Fidelity loading spinners to disappear."""
        loading_selectors = [
            Selectors.LOADING_SPINNER_1,
            Selectors.LOADING_SPINNER_2,
            Selectors.LOADING_SPINNER_3,
            Selectors.LOADING_SPINNER_4,
        ]
        for selector in loading_selectors:
            try:
                locator = self.page.locator(selector).first
                await locator.wait_for(timeout=timeout, state="hidden")
            except Exception:
                # Spinner might not exist, that's fine
                pass

    async def save_storage_state(self) -> None:
        if self.save_state and self._storage_path and self._context:
            try:
                storage_state = await self._context.storage_state()
                with open(self._storage_path, "w") as f:
                    json.dump(storage_state, f)
            except Exception as e:
                print(f"Warning: Could not save storage state: {e}")

    async def close(self) -> None:
        try:
            await self.save_storage_state()
            if self.debug and self._context:
                trace_name = f"fidelity_patchright_trace{self.title or ''}.zip"
                await self._context.tracing.stop(path=f"./{trace_name}")
            if self._context:
                await self._context.close()
            if self._browser:
                await self._browser.close()
            if self._playwright:
                await self._playwright.stop()
        finally:
            self._page = None
            self._context = None
            self._browser = None
            self._playwright = None
            self._initialized = False

    async def __aenter__(self) -> "PatchrightBrowserAsync":
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()
