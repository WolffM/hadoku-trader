# Fidelity Authentication Options

## Overview

There are three ways to authenticate with Fidelity for automated trading:

1. **Firefox Cookie Extraction** (Recommended for initial setup)
2. **TOTP Secret** (Recommended for long-term automation)
3. **Session Persistence** (Built-in via `save_state=True`)

---

## Option 1: Firefox Cookie Extraction (NEW)

Extract cookies from your Firefox browser where you're already logged into Fidelity:

```bash
cd fidelity-api
python fidelity/firefox_cookies.py
```

This creates `Fidelity.json` with your session cookies. Then use:

```python
from fidelity import fidelity

browser = fidelity.FidelityAutomation(headless=True, save_state=True)
# Cookies are automatically loaded from Fidelity.json
```

**Pros:**
- No need to manually enter TOTP or handle 2FA
- Works immediately if you have an active Firefox session
- Good for initial setup

**Cons:**
- Cookies expire (typically after a few days/weeks)
- Firefox must be closed when extracting cookies
- Need to re-extract when session expires

---

## Option 2: TOTP Secret (ALREADY IMPLEMENTED)

The `login()` method already supports TOTP secrets for fully automated authentication:

```python
from fidelity import fidelity

browser = fidelity.FidelityAutomation(headless=True, save_state=True)

# Pass your TOTP secret - login is fully automated
step_1, step_2 = browser.login(
    username="YOUR_USERNAME",
    password="YOUR_PASSWORD",
    totp_secret="YOUR_TOTP_SECRET",  # <-- This enables automation
    save_device=False  # Recommended: False for reliability
)

if step_1 and step_2:
    print("Logged in automatically!")
```

## How to Get Your TOTP Secret from Fidelity

This is the tricky part. When setting up 2FA with an authenticator app:

### Option 1: During Initial Setup
1. Go to Fidelity Security Settings → Two-Factor Authentication
2. Choose "Authenticator App"
3. When shown the QR code, look for **"Can't scan the code?"** or **"Enter manually"**
4. This reveals the secret key (e.g., `JBSWY3DPEHPK3PXP`)
5. Save this secret securely

### Option 2: If Already Set Up
You'll need to **reset your 2FA** to get the secret again:
1. Disable authenticator app 2FA in Fidelity settings
2. Re-enable it and use Option 1 above

### Option 3: Extract from QR Code
If you have the QR code image:
1. Use a QR decoder (online or app)
2. The decoded URL looks like: `otpauth://totp/Fidelity:username?secret=ABCDEFGH&issuer=Fidelity`
3. The `secret=ABCDEFGH` part is your TOTP secret

### Option 4: Export from Authenticator App
Some apps let you export/view secrets:
- **Authy**: Desktop app can show secrets
- **1Password/Bitwarden**: Shows secret in item details
- **Google Authenticator**: Use Google's export feature, then decode

## Environment Variable Pattern (Recommended)

```python
import os
from fidelity import fidelity

browser = fidelity.FidelityAutomation(headless=True)
browser.login(
    username=os.environ["FIDELITY_USERNAME"],
    password=os.environ["FIDELITY_PASSWORD"],
    totp_secret=os.environ["FIDELITY_TOTP_SECRET"]
)
```

---

## Option 3: Session Persistence

The library automatically saves session state when `save_state=True`:

```python
browser = fidelity.FidelityAutomation(headless=True, save_state=True)
# First time: do TOTP login
# Subsequent runs: session may still be valid
```

---

## Recommended Strategy: Cookie Bootstrap + TOTP Fallback

For the most reliable automation:

1. **Initial Setup**: Extract Firefox cookies to bootstrap the session
2. **Configure TOTP**: Set up TOTP secret as fallback for when cookies expire
3. **Let it handle auth**: The library will try cookies first, use TOTP if needed

```python
import os
from fidelity import fidelity

browser = fidelity.FidelityAutomation(
    headless=True,
    save_state=True,  # Uses Fidelity.json for cookies
    profile_path="."  # Where to find/save Fidelity.json
)

# Try to access a page - if session is valid, this works
# If not, login with TOTP
step_1, step_2 = browser.login(
    username=os.environ["FIDELITY_USERNAME"],
    password=os.environ["FIDELITY_PASSWORD"],
    totp_secret=os.environ.get("FIDELITY_TOTP_SECRET"),  # Optional fallback
    save_device=False
)
```

---

## Important Notes

1. **Never commit secrets to git** - use environment variables or a secrets manager
2. **`save_device=False` is recommended** for automation - it ensures 2FA is always triggered, making the flow predictable
3. **Headless mode works** - `headless=True` is fine for server deployments
4. If `totp_secret` is `None` or `"NA"`, the library falls back to SMS-based 2FA (requires manual `login_2FA()` call)
5. **Cookie extraction requires Firefox to be closed** - Firefox locks the database while running
6. **Fidelity.json should be in .gitignore** - it contains sensitive session data