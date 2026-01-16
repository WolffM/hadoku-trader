"""
Hadoku Fidelity - Trading automation with FastAPI service.

Usage:
    from hadoku_fidelity import create_app

    # Create FastAPI app (uses async client internally)
    app = create_app()

    # Or use the async client directly
    from hadoku_fidelity import FidelityClientAsync
    async with FidelityClientAsync() as client:
        await client.login(...)
"""

from fidelity import FidelityClient, FidelityAutomation
from fidelity.async_client import FidelityClientAsync
from fidelity.models import Account, Stock, OrderResult, LoginResult
from fidelity.exceptions import (
    FidelityError,
    AuthenticationError,
    TransactionError,
    OrderPreviewError,
    OrderSubmitError,
)

from .app import create_app
from .service import TraderService, TraderConfig

__all__ = [
    # Clients
    "FidelityClient",
    "FidelityAutomation",
    "FidelityClientAsync",
    # Models
    "Account",
    "Stock",
    "OrderResult",
    "LoginResult",
    # Exceptions
    "FidelityError",
    "AuthenticationError",
    "TransactionError",
    "OrderPreviewError",
    "OrderSubmitError",
    # Service
    "create_app",
    "TraderService",
    "TraderConfig",
]

__version__ = "1.0.4"
