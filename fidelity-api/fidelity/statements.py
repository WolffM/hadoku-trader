"""
Statements module for Fidelity API.

Handles downloading account statements.
"""

import os
import re
from enum import Enum
from typing import Optional

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .browser import FidelityBrowser
from .selectors import URLs, Selectors, Timeouts


class FidelityMonth(Enum):
    """Months as labeled by Fidelity in statements."""
    Jan = 1
    Feb = 2
    March = 3
    April = 4
    May = 5
    June = 6
    July = 7
    Aug = 8
    Sep = 9
    Oct = 10
    Nov = 11
    Dec = 12


class FidelityStatements:
    """Handles Fidelity statement downloads."""

    def __init__(self, browser: FidelityBrowser, title: Optional[str] = None) -> None:
        """
        Initialize statements handler.

        Args:
            browser: FidelityBrowser instance.
            title: Optional title for organizing downloaded files.
        """
        self.browser = browser
        self.title = title

    def download_statements(self, date: str) -> Optional[list[str]]:
        """
        Download account statements for a given month.

        Args:
            date: Month and year in format "YYYY/MM" (e.g., "2024/01").

        Returns:
            List of absolute file paths to downloaded statements,
            or None if no statements found or error occurred.
        """
        # Parse date
        target_month, target_year = self._parse_date(date)
        if target_month is None or target_year is None:
            return None

        month_name = FidelityMonth(target_month).name

        try:
            page = self.browser.page

            # Set up popup handler for beneficiary dialog
            self._setup_popup_handler()

            # Navigate to documents
            self.browser.goto(URLs.DOCUMENTS)

            # Select year
            if not self._select_year(target_year):
                return None

            # Wait for statements to load
            page.locator(Selectors.STATEMENTS_SKELETON).nth(1).wait_for(state="hidden")

            # Check for no statements
            if page.get_by_text("There are no statements").is_visible():
                return None

            # Expand results if needed
            if not self._expand_results():
                return None

            # Find matching statements
            valid_rows = self._find_matching_statements(target_year, target_month, month_name)

            # Download statements
            return self._download_statement_files(valid_rows)

        except Exception as e:
            print(f"Statement download error: {e}")
            return None

    def _parse_date(self, date: str) -> tuple[Optional[int], Optional[int]]:
        """Parse YYYY/MM date string."""
        try:
            parts = date.split("/")
            if len(parts) != 2:
                return None, None

            year = int(parts[0])
            month = int(parts[1])

            if month < 1 or month > 12:
                return None, None

            return month, year
        except ValueError:
            return None, None

    def _setup_popup_handler(self) -> None:
        """Set up handler for beneficiary popup dialog."""
        page = self.browser.page

        def close_popup():
            page.get_by_role("button", name=Selectors.DIALOG_CLOSE).click()
            return True

        page.add_locator_handler(
            page.locator(".pvd3-cim-modal-root > .pvd-modal__overlay"),
            close_popup,
        )

    def _select_year(self, target_year: int) -> bool:
        """Select the target year in the date dropdown."""
        page = self.browser.page

        try:
            page.get_by_role("button", name="Changing").click(timeout=Timeouts.SHORT)
            page.get_by_role("menuitem", name=str(target_year)).click(
                timeout=Timeouts.SHORT
            )
            return True
        except PlaywrightTimeoutError:
            print(f"Could not select year {target_year}")
            return False

    def _expand_results(self) -> bool:
        """Expand statement results if needed."""
        page = self.browser.page

        load_more = page.get_by_role("button", name="Load more results")
        if load_more.is_visible():
            try:
                load_more.click(timeout=Timeouts.SHORT)
            except PlaywrightTimeoutError:
                if not page.get_by_text("Showing all results").is_visible():
                    return False

        elif not page.get_by_text("Showing all results").is_visible():
            return False

        return True

    def _find_matching_statements(
        self,
        target_year: int,
        target_month: int,
        month_name: str,
    ) -> list:
        """Find statement rows matching the target date."""
        page = self.browser.page
        valid_rows = []

        page.wait_for_timeout(1000)
        items = page.get_by_role("row").all()

        for item in items:
            text = item.inner_text()

            # Skip if doesn't contain target year
            if not re.search(str(target_year), text):
                continue

            # Direct month match
            if re.search(month_name, text):
                valid_rows.append(item)
                continue

            # Handle date ranges (e.g., "Jan - March 2024")
            found_months = []
            for month in FidelityMonth.__members__.keys():
                if len(found_months) >= 2:
                    break
                if re.search(month, text):
                    found_months.append(month)

            if len(found_months) == 2:
                start = FidelityMonth[found_months[0]].value
                end = FidelityMonth[found_months[1]].value
                if start <= target_month <= end:
                    valid_rows.append(item)

        return valid_rows

    def _download_statement_files(self, rows: list) -> list[str]:
        """Download statement files from the matching rows."""
        page = self.browser.page
        saved_files = []

        # Determine subfolder
        subfolder = f"{self.title}/" if self.title else ""

        for row in rows:
            try:
                with page.expect_download() as download_info:
                    with page.expect_popup() as popup_info:
                        row.filter(has=page.get_by_role("link")).click(
                            timeout=Timeouts.SHORT
                        )
                    popup = popup_info.value

                download = download_info.value

                # Create filename and directory
                filename = f"./Statements/{subfolder}{len(saved_files)} - {download.suggested_filename}"
                os.makedirs(os.path.dirname(filename), exist_ok=True)

                full_path = os.path.join(os.getcwd(), filename)
                download.save_as(full_path)
                popup.close()

                saved_files.append(full_path)

            except Exception as e:
                print(f"Error downloading statement: {e}")

        return saved_files if saved_files else None
