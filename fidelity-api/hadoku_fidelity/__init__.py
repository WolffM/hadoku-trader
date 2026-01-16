"""
Hadoku Fidelity - Trading automation with FastAPI service.

Usage:
    from hadoku_fidelity import create_app, FidelityClient

    # Create FastAPI app
    app = create_app()

    # Or use the client directly
    client = FidelityClient()
"""

from fidelity import FidelityClient, FidelityAutomation
from fidelity.models import Account, Stock, OrderResult, LoginResult
from fidelity.exceptions import FidelityError, AuthenticationError, OrderError

from .app import create_app
from .service import TraderService

__all__ = [
    # Client
    "FidelityClient",
    "FidelityAutomation",
    # Models
    "Account",
    "Stock",
    "OrderResult",
    "LoginResult",
    # Exceptions
    "FidelityError",
    "AuthenticationError",
    "OrderError",
    # Service
    "create_app",
    "TraderService",
]

__version__ = "1.0.0"
