#!/usr/bin/env python3
"""
Test script for dry-run trade execution.
Uses the same pattern as test_totp_login.py.

This script:
1. Logs into Fidelity
2. Navigates to the trade page
3. Fills in a trade form
4. Gets to "Preview order" (but does NOT place the order)
5. Reports success

Usage:
    python test_dry_run.py
    python test_dry_run.py --ticker AAPL --quantity 1 --action buy
"""

import os
import sys
import argparse

# Load environment variables from .env
from dotenv import load_dotenv
load_dotenv()
load_dotenv("../.env")

from fidelity import FidelityClient


def test_dry_run(ticker: str = "AAPL", quantity: int = 1, action: str = "buy"):
    """Run a dry-run trade test using the sync FidelityClient."""

    print("Fidelity Dry Run Trade Test")
    print("=" * 50)

    # Get credentials from environment
    username = os.environ.get("FIDELITY_USERNAME")
    password = os.environ.get("FIDELITY_PASSWORD")
    totp_secret = os.environ.get("FIDELITY_TOTP_SECRET")
    default_account = os.environ.get("FIDELITY_DEFAULT_ACCOUNT")

    if not all([username, password, totp_secret]):
        print("[FAIL] Missing credentials in .env")
        print("Required: FIDELITY_USERNAME, FIDELITY_PASSWORD, FIDELITY_TOTP_SECRET")
        return False
    print("[OK] Credentials loaded")

    if not default_account:
        print("[WARN] FIDELITY_DEFAULT_ACCOUNT not set, will use first account")

    print(f"\nTrade parameters:")
    print(f"  Ticker: {ticker}")
    print(f"  Action: {action}")
    print(f"  Quantity: {quantity}")
    print(f"  Account: {default_account or '(auto)'}")
    print(f"  Dry Run: True (preview only)")

    print("\nInitializing browser...")

    with FidelityClient(
        headless=False,  # Show browser for visual verification
        save_state=True,
        profile_path=".",
        debug=False
    ) as client:
        try:
            # Step 1: Login
            print("\nStep 1: Logging in with TOTP...")
            step1_success, fully_logged_in = client.login(
                username=username,
                password=password,
                totp_secret=totp_secret,
                save_device=False
            )

            if not fully_logged_in:
                print("[FAIL] Login failed")
                return False
            print("[OK] Logged in successfully")

            # Step 2: Get account info to find account number
            print("\nStep 2: Getting account info...")
            account_info = client.getAccountInfo()

            if not account_info:
                print("[FAIL] Could not get account info")
                return False

            # Use default account or first available
            if default_account and default_account in account_info:
                target_account = default_account
            else:
                target_account = list(account_info.keys())[0]

            print(f"[OK] Using account: {target_account}")

            # Step 3: Execute dry run trade
            print(f"\nStep 3: Executing dry run trade...")
            print(f"  {action.upper()} {quantity} shares of {ticker}")

            success, error_message = client.transaction(
                stock=ticker,
                quantity=quantity,
                action=action,
                account=target_account,
                dry=True  # IMPORTANT: Preview only, do NOT submit
            )

            if success:
                print("\n" + "=" * 50)
                print("[OK] SUCCESS - Trade preview completed!")
                print(f"Alert: SUCCESS")
                print("=" * 50)
                print("\nThe order preview was successful.")
                print("If dry=False were used, the order would be placed.")
                print("\nVerify visually: The browser should show the order preview page.")

                # Give user time to see the preview (5 seconds)
                import time
                time.sleep(5)
                return True
            else:
                # Parse the error to get the alert code
                from fidelity.trading import classify_error
                alert = classify_error(error_message or "")
                print(f"\n[FAIL] Trade preview failed")
                print(f"  Alert: {alert.value}")
                print(f"  Message: {error_message}")
                return False

        except Exception as e:
            print(f"\n[ERROR] {e}")
            import traceback
            traceback.print_exc()
            return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test fidelity-api dry run trade")
    parser.add_argument("--ticker", default="AAPL", help="Ticker symbol (default: AAPL)")
    parser.add_argument("--quantity", type=int, default=1, help="Quantity (default: 1)")
    parser.add_argument("--action", default="buy", choices=["buy", "sell"], help="Action (default: buy)")

    args = parser.parse_args()

    success = test_dry_run(
        ticker=args.ticker,
        quantity=args.quantity,
        action=args.action,
    )

    sys.exit(0 if success else 1)
