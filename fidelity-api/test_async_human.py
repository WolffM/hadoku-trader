#!/usr/bin/env python3
"""
Test script for async client with human-like behavior.
Tests the bot detection evasion via human-like delays and typing.

Usage:
    python test_async_human.py
    python test_async_human.py --ticker AAPL --quantity 1 --action buy
"""

import os
import sys
import asyncio
import argparse

# Load environment variables from .env
from dotenv import load_dotenv
load_dotenv()
load_dotenv("../.env")

from fidelity.async_client import FidelityClientAsync


async def test_login_with_human_behavior():
    """Test login with human-like behavior to evade bot detection."""

    print("=" * 60)
    print("ASYNC CLIENT TEST - Human-Like Behavior")
    print("=" * 60)

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
    print(f"[INFO] Default account: {default_account or '(auto)'}")

    print("\n[INFO] Initializing browser (headed mode)...")
    print("[INFO] Human-like behavior enabled:")
    print("  - Random delays between actions (800-2500ms)")
    print("  - Character-by-character typing (50-200ms/char)")
    print("  - Mouse movements")
    print("  - 'Thinking' pauses")

    client = FidelityClientAsync(
        headless=False,  # Headed mode to visually verify
        save_state=True,
        profile_path=".",
        debug=False,
    )

    try:
        await client.initialize()
        print("[OK] Browser initialized")

        # Step 1: Login
        print("\n[STEP 1] Logging in with TOTP (human-like)...")
        print("  [INFO] This will be slower due to human-like delays")

        step1_success, fully_logged_in = await client.login(
            username=username,
            password=password,
            totp_secret=totp_secret,
            save_device=False,
        )

        if not fully_logged_in:
            print("[FAIL] Login failed - possible bot detection?")
            print("  Check the browser window for error messages.")

            # Wait for user to see the error
            print("\n  Waiting 10 seconds for manual inspection...")
            await asyncio.sleep(10)
            return False

        print("[OK] Login successful!")

        # Step 2: Get account info
        print("\n[STEP 2] Getting account info...")
        account_info = await client.get_account_info()

        if not account_info:
            print("[WARN] Could not get account info")
        else:
            print(f"[OK] Found {len(account_info)} account(s)")
            for acc_num, acc in account_info.items():
                print(f"  - {acc_num}: ${acc.balance:.2f}")

        # Determine target account
        if default_account and account_info and default_account in account_info:
            target_account = default_account
        elif account_info:
            target_account = list(account_info.keys())[0]
        else:
            target_account = default_account

        if not target_account:
            print("[FAIL] No account available")
            return False

        print(f"\n[INFO] Using account: {target_account}")

        # Step 3: Dry run trade
        print("\n[STEP 3] Executing dry run trade (BUY 1 AAPL)...")

        success, error_message, alert = await client.transaction(
            stock="AAPL",
            quantity=1,
            action="buy",
            account=target_account,
            dry=True,  # Preview only
        )

        if success:
            print("[OK] Trade preview successful!")
            print(f"  Alert: {alert}")
        else:
            print(f"[FAIL] Trade preview failed")
            print(f"  Alert: {alert}")
            print(f"  Error: {error_message}")

        # Give user time to see the result
        print("\n[INFO] Waiting 5 seconds for visual inspection...")
        await asyncio.sleep(5)

        return success

    except Exception as e:
        print(f"\n[ERROR] {e}")
        import traceback
        traceback.print_exc()
        return False

    finally:
        print("\n[INFO] Closing browser...")
        await client.close()


async def main():
    parser = argparse.ArgumentParser(description="Test async client with human behavior")
    parser.add_argument("--ticker", default="AAPL", help="Ticker symbol")
    parser.add_argument("--quantity", type=int, default=1, help="Quantity")
    parser.add_argument("--action", default="buy", choices=["buy", "sell"])

    args = parser.parse_args()

    success = await test_login_with_human_behavior()

    print("\n" + "=" * 60)
    if success:
        print("TEST PASSED - Human-like behavior worked!")
    else:
        print("TEST FAILED - Check browser for bot detection messages")
    print("=" * 60)

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
