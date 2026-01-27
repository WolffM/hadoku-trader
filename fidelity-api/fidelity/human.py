"""
Human-like behavior simulation for bot detection evasion.

Provides random delays and typing patterns that mimic real user behavior.
"""

import asyncio
import random
from typing import Optional

from playwright.async_api import Page as AsyncPage


# Delay ranges in milliseconds
class Delays:
    """Human-like delay ranges."""

    # Between major actions (clicking buttons, navigating)
    ACTION_MIN = 800
    ACTION_MAX = 2500

    # Between minor actions (field focus, small clicks)
    MINOR_MIN = 300
    MINOR_MAX = 800

    # After page loads
    PAGE_LOAD_MIN = 1500
    PAGE_LOAD_MAX = 4000

    # Between keystrokes when typing
    KEYSTROKE_MIN = 50
    KEYSTROKE_MAX = 200

    # Pause before submitting important forms
    SUBMIT_MIN = 1000
    SUBMIT_MAX = 3000

    # Random "thinking" pauses
    THINK_MIN = 500
    THINK_MAX = 2000


def random_delay(min_ms: int, max_ms: int) -> int:
    """Generate a random delay in milliseconds."""
    return random.randint(min_ms, max_ms)


async def human_delay(min_ms: int = Delays.ACTION_MIN, max_ms: int = Delays.ACTION_MAX) -> None:
    """Wait for a random human-like duration."""
    delay = random_delay(min_ms, max_ms)
    await asyncio.sleep(delay / 1000)


async def action_delay() -> None:
    """Delay between major actions."""
    await human_delay(Delays.ACTION_MIN, Delays.ACTION_MAX)


async def minor_delay() -> None:
    """Delay between minor actions."""
    await human_delay(Delays.MINOR_MIN, Delays.MINOR_MAX)


async def page_load_delay() -> None:
    """Delay after page loads."""
    await human_delay(Delays.PAGE_LOAD_MIN, Delays.PAGE_LOAD_MAX)


async def submit_delay() -> None:
    """Delay before submitting forms."""
    await human_delay(Delays.SUBMIT_MIN, Delays.SUBMIT_MAX)


async def think_delay() -> None:
    """Random thinking pause."""
    await human_delay(Delays.THINK_MIN, Delays.THINK_MAX)


async def human_type(page: AsyncPage, selector_or_locator, text: str, clear: bool = True) -> None:
    """
    Type text in a human-like manner with random delays between keystrokes.

    Args:
        page: Playwright page
        selector_or_locator: CSS selector string or Playwright locator
        text: Text to type
        clear: Clear existing content first
    """
    # Get the locator
    if isinstance(selector_or_locator, str):
        element = page.locator(selector_or_locator)
    else:
        element = selector_or_locator

    # Click to focus
    await element.click()
    await minor_delay()

    # Clear if requested
    if clear:
        await element.fill("")
        await minor_delay()

    # Type character by character with random delays
    for char in text:
        await element.press(char)
        delay = random_delay(Delays.KEYSTROKE_MIN, Delays.KEYSTROKE_MAX)
        await asyncio.sleep(delay / 1000)


async def human_click(page: AsyncPage, selector_or_locator, wait_after: bool = True) -> None:
    """
    Click an element with human-like behavior.

    Args:
        page: Playwright page
        selector_or_locator: CSS selector string or Playwright locator
        wait_after: Wait after clicking
    """
    # Get the locator
    if isinstance(selector_or_locator, str):
        element = page.locator(selector_or_locator)
    else:
        element = selector_or_locator

    # Small delay before click (like moving mouse to element)
    await minor_delay()

    # Click
    await element.click()

    # Wait after click
    if wait_after:
        await action_delay()


async def human_fill(page: AsyncPage, selector_or_locator, text: str) -> None:
    """
    Fill a field with human-like behavior (faster than human_type but still has delays).

    Use this for non-sensitive fields where typing speed doesn't matter.
    Use human_type for login credentials where keystroke timing may be monitored.

    Args:
        page: Playwright page
        selector_or_locator: CSS selector string or Playwright locator
        text: Text to fill
    """
    # Get the locator
    if isinstance(selector_or_locator, str):
        element = page.locator(selector_or_locator)
    else:
        element = selector_or_locator

    # Click to focus
    await element.click()
    await minor_delay()

    # Fill (instant but after human-like focus delay)
    await element.fill(text)
    await minor_delay()


async def random_mouse_movement(page: AsyncPage, count: int = 2) -> None:
    """
    Perform random mouse movements to simulate human behavior.

    Args:
        page: Playwright page
        count: Number of random movements
    """
    viewport = page.viewport_size
    if not viewport:
        return

    for _ in range(count):
        x = random.randint(100, viewport["width"] - 100)
        y = random.randint(100, viewport["height"] - 100)
        await page.mouse.move(x, y)
        await human_delay(100, 300)


async def scroll_naturally(page: AsyncPage, direction: str = "down", amount: int = 300) -> None:
    """
    Scroll the page in a natural way.

    Args:
        page: Playwright page
        direction: "up" or "down"
        amount: Approximate pixels to scroll
    """
    # Randomize the scroll amount slightly
    actual_amount = random.randint(int(amount * 0.8), int(amount * 1.2))

    if direction == "up":
        actual_amount = -actual_amount

    await page.mouse.wheel(0, actual_amount)
    await minor_delay()
