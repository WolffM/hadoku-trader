#!/usr/bin/env python3
"""
Test script for Patchright-based Fidelity client.

This tests the CDP-level stealth that Patchright provides to bypass
Fidelity's bot detection. Uses Chromium with Chrome channel.

Usage:
    python test_patchright.py
    python test_patchright.py --ticker AAPL --quantity 1 --action buy
"""

import os
import sys
import asyncio
import argparse

# Load environment variables from .env
from dotenv import load_dotenv
load_dotenv()
load_dotenv("../.env")

from fidelity.patchright_client import FidelityClientPatchright


async def test_patchright_login():
    """Test login with Patchright to bypass CDP detection."""

    print("=" * 60)
    print("PATCHRIGHT CLIENT TEST - CDP-Level Stealth")
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

    print("\n[INFO] Initializing Patchright browser...")
    print("[INFO] Using Chromium with Chrome channel for best stealth")
    print("[INFO] CDP patches enabled:")
    print("  - Runtime.enable disabled")
    print("  - Automation flags removed at protocol level")
    print("  - Human-like behavior for interactions")

    client = FidelityClientPatchright(
        headless=False,  # Patchright works best headed
        save_state=True,
        profile_path=".",
        debug=False,
    )

    try:
        await client.initialize()
        print("[OK] Browser initialized")

        # Step 1: Login
        print("\n[STEP 1] Logging in with TOTP...")

        step1_success, fully_logged_in = await client.login(
            username=username,
            password=password,
            totp_secret=totp_secret,
            save_device=False,
        )

        if not fully_logged_in:
            print("[FAIL] Login failed - check browser for errors")
            print("  Waiting 10 seconds for manual inspection...")
            await asyncio.sleep(10)
            return False

        print("[OK] Login successful!")

        # Step 2: Get accounts from trade page (more reliable)
        print("\n[STEP 2] Getting accounts from trade page...")
        target_account = default_account

        if not target_account:
            try:
                accounts = await client.get_accounts_from_trade_page()
                if accounts:
                    target_account = accounts[0]
                    print(f"[OK] Using first account: {target_account}")
                else:
                    print("[WARN] No accounts found in dropdown")
            except Exception as e:
                print(f"[WARN] Account retrieval failed: {e}")

        if not target_account:
            print("[FAIL] No account available - set FIDELITY_DEFAULT_ACCOUNT in .env")
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
    parser = argparse.ArgumentParser(description="Test Patchright client with CDP stealth")
    parser.add_argument("--ticker", default="AAPL", help="Ticker symbol")
    parser.add_argument("--quantity", type=int, default=1, help="Quantity")
    parser.add_argument("--action", default="buy", choices=["buy", "sell"])

    args = parser.parse_args()

    success = await test_patchright_login()

    print("\n" + "=" * 60)
    if success:
        print("TEST PASSED - Patchright bypassed bot detection!")
    else:
        print("TEST FAILED - Check browser for errors")
    print("=" * 60)

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
