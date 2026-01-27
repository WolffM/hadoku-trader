"""
Browser management for Fidelity API.

Handles Playwright browser initialization, stealth settings, and page management.
Supports both sync and async operation modes.
"""

import os
import json
import asyncio
from typing import Optional, Union

from playwright.async_api import async_playwright, Page as AsyncPage, Browser as AsyncBrowser, BrowserContext as AsyncBrowserContext
from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright_stealth import Stealth

from .selectors import Selectors, Timeouts


class FidelityBrowser:
    """
    Manages the Playwright browser instance for Fidelity automation.
    Sync version - use FidelityBrowserAsync for async contexts.
    """

    def __init__(
        self,
        headless: bool = True,
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
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

        # Enhanced stealth configuration to avoid bot detection
        self._stealth = Stealth(
            navigator_languages=True,
            navigator_user_agent=True,
            navigator_vendor=True,
            navigator_platform=True,
            navigator_plugins=True,
            navigator_permissions=True,
            navigator_webdriver=True,  # Critical: hides webdriver flag
            webgl_vendor=True,
            webgl_renderer=True,
            chrome_app=True,
            chrome_csi=True,
            chrome_load_times=True,
            chrome_runtime=True,
            iframe_content_window=True,
            media_codecs=True,
            hairline=True,
        )

        self._initialize()

    def _initialize(self) -> None:
        """Initialize the browser, context, and page."""
        self._playwright = sync_playwright().start()

        if self.save_state:
            self._storage_path = self._get_storage_path()
            self._ensure_storage_file()

        self._browser = self._playwright.firefox.launch(
            headless=self.headless,
            args=["--disable-webgl", "--disable-software-rasterizer"],
        )

        self._context = self._browser.new_context(
            storage_state=self._storage_path if self.save_state else None
        )

        if self.debug:
            self._context.tracing.start(
                name="fidelity_trace",
                screenshots=True,
                snapshots=True,
            )

        self._page = self._context.new_page()
        self._stealth.apply_stealth_sync(self._page)

    def _get_storage_path(self) -> str:
        base_path = os.path.abspath(self.profile_path)
        filename = f"Fidelity_{self.title}.json" if self.title else "Fidelity.json"
        return os.path.join(base_path, filename)

    def _ensure_storage_file(self) -> None:
        if self._storage_path and not os.path.exists(self._storage_path):
            os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
            with open(self._storage_path, "w") as f:
                json.dump({}, f)

    @property
    def page(self) -> Page:
        if self._page is None:
            raise RuntimeError("Browser not initialized")
        return self._page

    @property
    def context(self) -> BrowserContext:
        if self._context is None:
            raise RuntimeError("Browser not initialized")
        return self._context

    def goto(self, url: str, wait_for_load: bool = True) -> None:
        if wait_for_load:
            self.page.wait_for_load_state(state="load")
        self.page.goto(url)

    def wait_for_loading(self, timeout: int = Timeouts.DEFAULT) -> None:
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
        if self.save_state and self._storage_path:
            storage_state = self._context.storage_state()
            with open(self._storage_path, "w") as f:
                json.dump(storage_state, f)

    def close(self) -> None:
        try:
            self.save_storage_state()
            if self.debug:
                trace_name = f"fidelity_trace{self.title or ''}.zip"
                self._context.tracing.stop(path=f"./{trace_name}")
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
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()


class FidelityBrowserAsync:
    """
    Async version of FidelityBrowser for use in async contexts (FastAPI, etc).
    """

    def __init__(
        self,
        headless: bool = True,
        save_state: bool = True,
        profile_path: str = ".",
        title: Optional[str] = None,
        debug: bool = False,
    ) -> None:
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

        # Enhanced stealth configuration to avoid bot detection
        self._stealth = Stealth(
            navigator_languages=True,
            navigator_user_agent=True,
            navigator_vendor=True,
            navigator_platform=True,
            navigator_plugins=True,
            navigator_permissions=True,
            navigator_webdriver=True,  # Critical: hides webdriver flag
            webgl_vendor=True,
            webgl_renderer=True,
            chrome_app=True,
            chrome_csi=True,
            chrome_load_times=True,
            chrome_runtime=True,
            iframe_content_window=True,
            media_codecs=True,
            hairline=True,
        )

    async def initialize(self) -> "FidelityBrowserAsync":
        """Initialize the browser asynchronously. Must be called before use."""
        if self._initialized:
            return self

        self._playwright = await async_playwright().start()

        if self.save_state:
            self._storage_path = self._get_storage_path()
            self._ensure_storage_file()

        self._browser = await self._playwright.firefox.launch(
            headless=self.headless,
            args=["--disable-webgl", "--disable-software-rasterizer"],
        )

        self._context = await self._browser.new_context(
            storage_state=self._storage_path if self.save_state else None
        )

        if self.debug:
            await self._context.tracing.start(
                name="fidelity_trace",
                screenshots=True,
                snapshots=True,
            )

        self._page = await self._context.new_page()
        await self._stealth.apply_stealth_async(self._page)
        self._initialized = True
        return self

    def _get_storage_path(self) -> str:
        base_path = os.path.abspath(self.profile_path)
        filename = f"Fidelity_{self.title}.json" if self.title else "Fidelity.json"
        return os.path.join(base_path, filename)

    def _ensure_storage_file(self) -> None:
        if self._storage_path and not os.path.exists(self._storage_path):
            os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
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
        loading_selectors = [
            Selectors.LOADING_SPINNER_1,
            Selectors.LOADING_SPINNER_2,
            Selectors.LOADING_SPINNER_3,
            Selectors.LOADING_SPINNER_4,
        ]
        for selector in loading_selectors:
            locator = self.page.locator(selector).first
            await locator.wait_for(timeout=timeout, state="hidden")

    async def save_storage_state(self) -> None:
        if self.save_state and self._storage_path:
            storage_state = await self._context.storage_state()
            with open(self._storage_path, "w") as f:
                json.dump(storage_state, f)

    async def close(self) -> None:
        try:
            await self.save_storage_state()
            if self.debug:
                trace_name = f"fidelity_trace{self.title or ''}.zip"
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

    async def __aenter__(self) -> "FidelityBrowserAsync":
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()
