"""
Custom exceptions for Fidelity API.

Provides a clear exception hierarchy for different error types.
"""


class FidelityError(Exception):
    """Base exception for all Fidelity API errors."""
    pass


class AuthenticationError(FidelityError):
    """Raised when authentication fails."""
    pass


class LoginError(AuthenticationError):
    """Raised when login fails."""
    pass


class TwoFactorError(AuthenticationError):
    """Raised when 2FA verification fails."""
    pass


class TOTPRequiredError(AuthenticationError):
    """Raised when TOTP is required but not provided."""
    pass


class SessionExpiredError(AuthenticationError):
    """Raised when the session has expired."""
    pass


class TransactionError(FidelityError):
    """Base exception for transaction errors."""
    pass


class OrderPreviewError(TransactionError):
    """Raised when order preview doesn't match expected values."""
    pass


class OrderSubmitError(TransactionError):
    """Raised when order submission fails."""
    pass


class InsufficientFundsError(TransactionError):
    """Raised when there are insufficient funds for a transaction."""
    pass


class AccountError(FidelityError):
    """Base exception for account-related errors."""
    pass


class AccountNotFoundError(AccountError):
    """Raised when an account is not found."""
    pass


class AccountCreationError(AccountError):
    """Raised when account creation fails."""
    pass


class BrowserError(FidelityError):
    """Raised when browser operations fail."""
    pass


class TimeoutError(BrowserError):
    """Raised when a browser operation times out."""
    pass


class NavigationError(BrowserError):
    """Raised when page navigation fails."""
    pass


class ElementNotFoundError(BrowserError):
    """Raised when a page element cannot be found."""
    pass
