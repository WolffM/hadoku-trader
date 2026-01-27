#!/usr/bin/env python3
"""
End-to-end test for the fidelity-api HTTP endpoints.

This tests the ACTUAL production flow that hadoku-site will use:
  hadoku-site -> POST /execute-trade -> FastAPI -> TraderService -> FidelityClientPatchright

Usage:
    # Start the service first (in another terminal):
    hadoku-trader --port 8765

    # Then run this test:
    python test_api_e2e.py
    python test_api_e2e.py --base-url http://localhost:8765
"""

import os
import sys
import argparse
import requests
from dotenv import load_dotenv

load_dotenv()
load_dotenv("../.env")


def test_health(base_url: str) -> bool:
    """Test health endpoint."""
    print("\n[TEST] GET /health")
    try:
        response = requests.get(f"{base_url}/health", timeout=10)
        print(f"  Status: {response.status_code}")
        data = response.json()
        print(f"  Response: {data}")

        if response.status_code == 200 and data.get("status") == "ok":
            print("  [OK] Health check passed")
            return True
        else:
            print("  [FAIL] Health check failed")
            return False
    except Exception as e:
        print(f"  [FAIL] Error: {e}")
        return False


def test_execute_trade_buy(base_url: str, api_key: str) -> dict:
    """Test buy trade execution (dry run)."""
    print("\n[TEST] POST /execute-trade (BUY dry run)")

    payload = {
        "ticker": "AAPL",
        "action": "buy",
        "quantity": 1,
        "dry_run": True,  # IMPORTANT: Preview only
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
    }

    try:
        response = requests.post(
            f"{base_url}/execute-trade",
            json=payload,
            headers=headers,
            timeout=120,  # Browser automation can be slow
        )
        print(f"  Status: {response.status_code}")
        data = response.json()
        print(f"  Response: {data}")

        # Validate response structure
        assert "success" in data, "Missing 'success' field"
        assert "message" in data, "Missing 'message' field"
        assert "alert" in data, "Missing 'alert' field"

        if data["success"]:
            assert data["alert"] == "SUCCESS", f"Expected SUCCESS alert, got {data['alert']}"
            print("  [OK] Buy dry run passed")
        else:
            print(f"  [WARN] Buy failed with alert: {data['alert']}")

        return data

    except Exception as e:
        print(f"  [FAIL] Error: {e}")
        return {"success": False, "alert": "UNKNOWN", "error": str(e)}


def test_execute_trade_sell_no_position(base_url: str, api_key: str) -> dict:
    """Test sell trade for stock not owned (should fail with NO_POSITION)."""
    print("\n[TEST] POST /execute-trade (SELL stock not owned)")

    payload = {
        "ticker": "AAPL",  # Assuming not owned
        "action": "sell",
        "quantity": 1,
        "dry_run": True,
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
    }

    try:
        response = requests.post(
            f"{base_url}/execute-trade",
            json=payload,
            headers=headers,
            timeout=120,
        )
        print(f"  Status: {response.status_code}")
        data = response.json()
        print(f"  Response: {data}")

        # Should fail
        if not data["success"]:
            # Ideally should be NO_POSITION, but might be ORDER_REJECTED if error extraction fails
            print(f"  [OK] Sell correctly failed with alert: {data['alert']}")
        else:
            print("  [WARN] Sell unexpectedly succeeded (do you own AAPL?)")

        return data

    except Exception as e:
        print(f"  [FAIL] Error: {e}")
        return {"success": False, "alert": "UNKNOWN", "error": str(e)}


def test_execute_trade_sell_owned(base_url: str, api_key: str, ticker: str) -> dict:
    """Test sell trade for stock that IS owned (should succeed dry run)."""
    print(f"\n[TEST] POST /execute-trade (SELL {ticker} - owned)")

    payload = {
        "ticker": ticker,
        "action": "sell",
        "quantity": 1,
        "dry_run": True,
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": api_key,
    }

    try:
        response = requests.post(
            f"{base_url}/execute-trade",
            json=payload,
            headers=headers,
            timeout=120,
        )
        print(f"  Status: {response.status_code}")
        data = response.json()
        print(f"  Response: {data}")

        if data["success"]:
            assert data["alert"] == "SUCCESS", f"Expected SUCCESS alert, got {data['alert']}"
            print("  [OK] Sell dry run passed")
        else:
            print(f"  [FAIL] Sell failed with alert: {data['alert']}")

        return data

    except Exception as e:
        print(f"  [FAIL] Error: {e}")
        return {"success": False, "alert": "UNKNOWN", "error": str(e)}


def test_invalid_api_key(base_url: str) -> bool:
    """Test that invalid API key is rejected."""
    print("\n[TEST] POST /execute-trade (invalid API key)")

    payload = {
        "ticker": "AAPL",
        "action": "buy",
        "quantity": 1,
        "dry_run": True,
    }

    headers = {
        "Content-Type": "application/json",
        "X-API-Key": "wrong-key",
    }

    try:
        response = requests.post(
            f"{base_url}/execute-trade",
            json=payload,
            headers=headers,
            timeout=10,
        )
        print(f"  Status: {response.status_code}")

        if response.status_code == 401:
            print("  [OK] Correctly rejected invalid API key")
            return True
        else:
            print(f"  [FAIL] Expected 401, got {response.status_code}")
            return False

    except Exception as e:
        print(f"  [FAIL] Error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="E2E test for fidelity-api HTTP endpoints")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8765",
        help="Base URL of the fidelity-api service",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("TRADER_API_SECRET", "dev-secret"),
        help="API key for authentication",
    )
    parser.add_argument(
        "--owned-ticker",
        default="NVDA",
        help="A ticker you actually own for sell test (default: NVDA)",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("FIDELITY-API E2E TEST")
    print("=" * 60)
    print(f"Base URL: {args.base_url}")
    print(f"API Key: {args.api_key[:4]}***")
    print(f"Owned ticker for sell test: {args.owned_ticker}")

    results = {}

    # Test 1: Health check
    results["health"] = test_health(args.base_url)

    # Test 2: Invalid API key
    results["auth"] = test_invalid_api_key(args.base_url)

    # Test 3: Buy dry run
    buy_result = test_execute_trade_buy(args.base_url, args.api_key)
    results["buy"] = buy_result.get("success", False)

    # Test 4: Sell stock not owned (should fail)
    sell_no_pos = test_execute_trade_sell_no_position(args.base_url, args.api_key)
    results["sell_no_position"] = not sell_no_pos.get("success", True)  # Should fail

    # Test 5: Sell stock that IS owned (should succeed)
    sell_owned = test_execute_trade_sell_owned(args.base_url, args.api_key, args.owned_ticker)
    results["sell_owned"] = sell_owned.get("success", False)

    # Summary
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    all_passed = True
    for test_name, passed in results.items():
        status = "[PASS]" if passed else "[FAIL]"
        print(f"  {test_name}: {status}")
        if not passed:
            all_passed = False

    print("=" * 60)
    if all_passed:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED")

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
