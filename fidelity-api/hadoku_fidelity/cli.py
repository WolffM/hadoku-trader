"""
CLI entry point for running the trader service.

Usage:
    hadoku-trader                    # Run on default port 8765
    hadoku-trader --port 9000        # Run on custom port
    hadoku-trader --host 0.0.0.0     # Listen on all interfaces
"""

import argparse
import os


def main():
    parser = argparse.ArgumentParser(
        description="Hadoku Fidelity Trader Service",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TRADER_WORKER_PORT", 8765)),
        help="Port to listen on (default: 8765 or TRADER_WORKER_PORT env)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )

    args = parser.parse_args()

    # Import here to avoid slow startup for --help
    import uvicorn
    from .app import create_app

    app = create_app()

    print(f"Starting hadoku-trader on {args.host}:{args.port}")
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
