# Hadoku Trader Worker (Local)

Local PM2 service that executes trades via the Fidelity API.

## Overview

This service:

- Runs on your local machine
- Exposes HTTP endpoints via cloudflared tunnel
- Uses fidelity-api to execute actual trades on your Fidelity account

## Setup

### 1. Install dependencies

```bash
cd trader-worker
pip install -r requirements.txt

# Install Playwright browsers
playwright install firefox
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
# Fidelity credentials
FIDELITY_USERNAME=your_username
FIDELITY_PASSWORD=your_password
FIDELITY_TOTP_SECRET=your_totp_secret
FIDELITY_DEFAULT_ACCOUNT=X12345678

# API security
TRADER_API_SECRET=your_secure_secret

# Service config
TRADER_WORKER_PORT=8765
```

### 3. Test locally

```bash
# Run directly
python main.py

# Or with uvicorn
uvicorn main:app --host 127.0.0.1 --port 8765
```

### 4. Run with PM2

```bash
pm2 start ecosystem.config.js
pm2 logs trader-worker
```

### 5. Set up cloudflared tunnel

This service should be exposed via a cloudflared tunnel so hadoku-site can call it.

```bash
# Create tunnel (one-time)
cloudflared tunnel create trader-worker

# Configure tunnel to point to localhost:8765
# Add to your cloudflared config.yml
```

## API Endpoints

| Method | Path             | Description                       |
| ------ | ---------------- | --------------------------------- |
| GET    | /health          | Health check, returns auth status |
| POST   | /execute-trade   | Execute a trade                   |
| GET    | /accounts        | Get all accounts and balances     |
| POST   | /refresh-session | Force re-authentication           |

## Security

- All endpoints (except /health) require `X-API-Key` header
- The API key must match `TRADER_API_SECRET` env variable
- Never expose this service directly to the internet without the tunnel

## Integration with hadoku-site

hadoku-site's tunnel API should manage this service alongside other tunnels.
The cloudflared tunnel URL should be set as `TUNNEL_URL` in hadoku-site's worker secrets.
