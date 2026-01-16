<a id="readme-top"></a>
# fidelity-api

<!-- ABOUT THE PROJECT -->
## About The Project
This project aims to create an easy to use API for Fidelity.

Utilizing Playwright, a controlled browser is created through the api allowing users to place order, 
gather account positions, nickname accounts, etc.

Supports 2FA!

Made with the help of Jinhui Zhen
## Disclaimer
I am not a financial advisor and not affiliated with Fidelity in any way. Use this tool at your own risk. I am 
not responsible for any losses or damages you may incur by using this project. This tool is provided as-is 
with no warranty.

## Donations
If you feel this project has saved you time or provided value to you, you can send me a donation using the badge below!

[![ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white
)](https://ko-fi.com/kenny18067)

<!-- GETTING STARTED -->
## Getting Started

Install using pypi:
```sh
pip install fidelity-api
```

This package requires playwright. After installing fidelity-api, you will need to finish the install of playwright. You can do this in most cases by running the command:
```sh
playwright install
```

If you would like some more information on this, you can find it [here](https://playwright.dev/python/docs/intro).

## Quickstart
The example below will:
- login to fidelity
- gather account holdings
- place an order for the first account number found
```py
from fidelity import fidelity

browser = fidelity.FidelityAutomation(headless=False, save_state=False)

# Login
step_1, step_2 = browser.login(username="USER", password="PASS", save_device=True)
if step_1 and step_2:
    print("Logged in")
elif step_1 and not step_2:
    print("2FA code needed")
    code = input("Enter the code\n")
if browser.login_2FA(code):
    print("Logged in")
else:
    print("Browser not logged in")
    exit(1)

# Get accounts
account_info = browser.getAccountInfo()
accounts = account_info.keys()

# Test the transaction
success, errormsg = browser.transaction("INTC", 1, 'buy', accounts[0], True)
if success:
    print("Successfully tested transaction")
else:
    print(errormsg)

# Print withdrawal balance from each account
acc_dict = browser.get_list_of_accounts(set_flag=True, get_withdrawal_bal=True)
for account in acc_dict:
    print(f"{acc_dict[account]['nickname']}:  {account}: {acc_dict[account]['withdrawal_balance']}")

browser.close_browser()
```