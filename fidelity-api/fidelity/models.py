"""
Data models for Fidelity API.

Uses dataclasses for clean, typed data structures.
"""

from dataclasses import dataclass, field
from typing import Optional


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

    def __iter__(self):
        """Allow unpacking as tuple for backward compatibility."""
        return iter((self.success, self.error_message))


@dataclass
class LoginResult:
    """Result of a login attempt."""
    step1_success: bool
    fully_logged_in: bool

    def __iter__(self):
        """Allow unpacking as tuple for backward compatibility."""
        return iter((self.step1_success, self.fully_logged_in))
