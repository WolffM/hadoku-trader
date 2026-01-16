"""
Test script to verify Fidelity TOTP login is working.
Uses environment variables from .env:
  - FIDELITY_USERNAME
  - FIDELITY_PASSWORD
  - FIDELITY_TOTP_SECRET
"""

import os
import sys

# Load environment variables from .env
from dotenv import load_dotenv
load_dotenv()
# Also load from parent directory
load_dotenv("../.env")

# Use the new API
from fidelity import FidelityClient


def test_totp_login():
    print("Fidelity TOTP Login Test (Refactored API)")
    print("=" * 50)

    # Get credentials from environment
    username = os.environ.get("FIDELITY_USERNAME")
    password = os.environ.get("FIDELITY_PASSWORD")
    totp_secret = os.environ.get("FIDELITY_TOTP_SECRET")

    if not totp_secret:
        print("[FAIL] FIDELITY_TOTP_SECRET not found in .env")
        return False
    print("[OK] TOTP secret loaded")

    if not username or not password:
        print("[FAIL] FIDELITY_USERNAME and FIDELITY_PASSWORD required in .env")
        print("\nAdd these to your .env file:")
        print("  FIDELITY_USERNAME=your_username")
        print("  FIDELITY_PASSWORD=your_password")
        return False
    print("[OK] Credentials loaded")

    print("\nInitializing browser...")

    # Use the new FidelityClient with context manager
    with FidelityClient(
        headless=False,  # Set to True for headless mode
        save_state=True,
        profile_path=".",
        debug=False
    ) as client:
        try:
            print("Attempting login with TOTP...")

            # Attempt login with TOTP
            step1_success, fully_logged_in = client.login(
                username=username,
                password=password,
                totp_secret=totp_secret,
                save_device=False  # Don't save device for testing
            )

            if fully_logged_in:
                print("\n[OK] SUCCESS! Fully logged in with TOTP!")
                print(f"Current URL: {client.page.url}")

                # Try to get account info to verify session
                print("\nAttempting to get account info...")
                account_info = client.getAccountInfo()

                if account_info:
                    print(f"\n[OK] Found {len(account_info)} account(s):")
                    for acc_num, acc_data in account_info.items():
                        balance = acc_data.get('balance', 0)
                        nickname = acc_data.get('nickname', 'Unknown')
                        print(f"  - {nickname} ({acc_num}): ${balance:,.2f}")
                else:
                    print("[WARN] Could not retrieve account info")

                return True

            elif step1_success:
                print("\n[WARN] Initial login succeeded but 2FA is pending")
                print("This means TOTP wasn't used - check if TOTP is properly configured")
                return False

            else:
                print("\n[FAIL] Login failed")
                print("Check your username/password and TOTP secret")
                return False

        except Exception as e:
            print(f"\n[ERROR] {e}")
            import traceback
            traceback.print_exc()
            return False


if __name__ == "__main__":
    success = test_totp_login()
    sys.exit(0 if success else 1)
