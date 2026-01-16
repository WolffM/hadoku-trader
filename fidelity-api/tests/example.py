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