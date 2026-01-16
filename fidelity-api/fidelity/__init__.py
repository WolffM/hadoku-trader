"""
Fidelity API - Unofficial Python API for Fidelity.

A browser automation library for interacting with Fidelity accounts.

Example:
    ```python
    from fidelity import FidelityClient

    with FidelityClient(headless=True) as client:
        client.login("username", "password", "totp_secret")
        accounts = client.get_account_info()
        for acc_num, acc_data in accounts.items():
            print(f"{acc_data['nickname']}: ${acc_data['balance']:,.2f}")
    ```

For backward compatibility with the old API:
    ```python
    from fidelity import fidelity
    browser = fidelity.FidelityAutomation(headless=True)
    ```
"""

# Main client
from .client import FidelityClient, FidelityAutomation

# Models
from .models import Account, Stock, OrderResult, LoginResult

# Exceptions
from .exceptions import (
    FidelityError,
    AuthenticationError,
    LoginError,
    TwoFactorError,
    TOTPRequiredError,
    SessionExpiredError,
    TransactionError,
    OrderPreviewError,
    OrderSubmitError,
    InsufficientFundsError,
    AccountError,
    AccountNotFoundError,
    AccountCreationError,
    BrowserError,
    TimeoutError,
    NavigationError,
    ElementNotFoundError,
)

# Backward compatibility: expose 'fidelity' module with FidelityAutomation
from . import client as fidelity

# Helper functions for backward compatibility
from .models import Stock as _Stock


def create_stock_dict(
    ticker: str,
    quantity: float,
    last_price: float,
    value: float,
    stock_list: list = None,
) -> dict:
    """
    Create a stock dictionary (backward compatibility).

    Use Stock dataclass instead for new code.
    """
    stock = _Stock(
        ticker=ticker,
        quantity=quantity,
        last_price=last_price,
        value=value,
    )
    result = stock.to_dict()
    if stock_list is not None:
        stock_list.append(result)
    return result


def validate_stocks(stocks: list) -> bool:
    """
    Validate a list of stock dictionaries (backward compatibility).

    Use Stock dataclass instead for new code.
    """
    if stocks is None:
        return True

    required_fields = {"ticker", "quantity", "last_price", "value"}

    for stock in stocks:
        try:
            if not all(stock.get(f) is not None for f in required_fields):
                print("Missing fields in stock dict")
                return False

            if not isinstance(stock["ticker"], str):
                print("ticker must be str")
                return False

            for field in ["quantity", "last_price", "value"]:
                if not isinstance(stock[field], (int, float)):
                    print(f"{field} must be numeric")
                    return False

        except Exception as e:
            print(f"Stock validation error: {e}")
            return False

    return True


__all__ = [
    # Main client
    "FidelityClient",
    "FidelityAutomation",  # Backward compat alias
    # Models
    "Account",
    "Stock",
    "OrderResult",
    "LoginResult",
    # Exceptions
    "FidelityError",
    "AuthenticationError",
    "LoginError",
    "TwoFactorError",
    "TOTPRequiredError",
    "SessionExpiredError",
    "TransactionError",
    "OrderPreviewError",
    "OrderSubmitError",
    "InsufficientFundsError",
    "AccountError",
    "AccountNotFoundError",
    "AccountCreationError",
    "BrowserError",
    "TimeoutError",
    "NavigationError",
    "ElementNotFoundError",
    # Backward compat
    "fidelity",
    "create_stock_dict",
    "validate_stocks",
]

__version__ = "1.0.0"
