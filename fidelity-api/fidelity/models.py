"""
Data models for Fidelity API.

Uses dataclasses for clean, typed data structures.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class TradeAlert(str, Enum):
    """
    Standardized trade alert codes for error classification.

    These codes help identify the specific reason a trade failed,
    enabling better error handling and user feedback.
    """

    # Success
    SUCCESS = "SUCCESS"

    # Buy-specific errors
    INVALID_TICKER = "INVALID_TICKER"  # Ticker symbol not found
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"  # Not enough buying power

    # Sell-specific errors
    NO_POSITION = "NO_POSITION"  # No shares of ticker in account
    INSUFFICIENT_SHARES = "INSUFFICIENT_SHARES"  # Trying to sell more than owned
    SHARES_RESTRICTED = "SHARES_RESTRICTED"  # Shares held for settlement/margin

    # Market/timing errors
    MARKET_CLOSED = "MARKET_CLOSED"  # Market order outside trading hours
    STOCK_NOT_TRADEABLE = "STOCK_NOT_TRADEABLE"  # OTC/penny stock restrictions

    # Account errors
    ACCOUNT_RESTRICTED = "ACCOUNT_RESTRICTED"  # Account has trading restrictions
    SESSION_EXPIRED = "SESSION_EXPIRED"  # Authentication expired

    # Generic errors
    ORDER_REJECTED = "ORDER_REJECTED"  # Generic broker rejection
    TIMEOUT = "TIMEOUT"  # Page/network timeout
    UNKNOWN = "UNKNOWN"  # Unclassified error


@dataclass
class Stock:
    """Represents a stock position."""
    ticker: str
    quantity: float
    last_price: float
    value: float

    def to_dict(self) -> dict:
        """Convert to dictionary format for backward compatibility."""
        return {
            "ticker": self.ticker,
            "quantity": self.quantity,
            "last_price": self.last_price,
            "value": self.value,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Stock":
        """Create from dictionary."""
        return cls(
            ticker=data["ticker"],
            quantity=float(data["quantity"]),
            last_price=float(data["last_price"]),
            value=float(data["value"]),
        )


@dataclass
class Account:
    """Represents a Fidelity account."""
    account_number: str
    nickname: Optional[str] = None
    balance: float = 0.0
    withdrawal_balance: float = 0.0
    stocks: list[Stock] = field(default_factory=list)

    def add_stock(self, stock: Stock) -> None:
        """Add a stock position to the account."""
        self.stocks.append(stock)
        self.balance += stock.value

    def to_dict(self) -> dict:
        """Convert to dictionary format for backward compatibility."""
        return {
            "balance": round(self.balance, 2),
            "withdrawal_balance": round(self.withdrawal_balance, 2),
            "nickname": self.nickname,
            "stocks": [s.to_dict() for s in self.stocks],
        }

    @classmethod
    def from_dict(cls, account_number: str, data: dict) -> "Account":
        """Create from dictionary."""
        stocks = [Stock.from_dict(s) for s in data.get("stocks", [])]
        return cls(
            account_number=account_number,
            nickname=data.get("nickname"),
            balance=float(data.get("balance", 0.0)),
            withdrawal_balance=float(data.get("withdrawal_balance", 0.0)),
            stocks=stocks,
        )


@dataclass
class OrderResult:
    """Result of a transaction attempt."""
    success: bool
    error_message: Optional[str] = None
    alert: TradeAlert = TradeAlert.UNKNOWN

    def __iter__(self):
        """Allow unpacking as tuple for backward compatibility."""
        return iter((self.success, self.error_message))

    @property
    def alert_code(self) -> str:
        """Return the alert code as a string."""
        return self.alert.value


@dataclass
class LoginResult:
    """Result of a login attempt."""
    step1_success: bool
    fully_logged_in: bool

    def __iter__(self):
        """Allow unpacking as tuple for backward compatibility."""
        return iter((self.step1_success, self.fully_logged_in))
