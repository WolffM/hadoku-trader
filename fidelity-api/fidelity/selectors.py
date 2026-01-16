"""
Constants for Fidelity URLs and CSS selectors.

Centralizes all magic strings for easier maintenance.
"""

# =============================================================================
# URLs
# =============================================================================

class URLs:
    """Fidelity page URLs."""

    # Authentication
    LOGIN = "https://digital.fidelity.com/prgw/digital/login/full-page"

    # Portfolio
    SUMMARY = "https://digital.fidelity.com/ftgw/digital/portfolio/summary"
    POSITIONS = "https://digital.fidelity.com/ftgw/digital/portfolio/positions"
    FEATURES = "https://digital.fidelity.com/ftgw/digital/portfolio/features"
    DOCUMENTS = "https://digital.fidelity.com/ftgw/digital/portfolio/documents/dochub"

    # Trading
    TRADE_EQUITY = "https://digital.fidelity.com/ftgw/digital/trade-equity/index/orderEntry"

    # Transfers
    TRANSFER = "https://digital.fidelity.com/ftgw/digital/transfer/?quicktransfer=cash-shares"

    # Account Opening
    OPEN_ROTH = "https://digital.fidelity.com/ftgw/digital/aox/RothIRAccountOpening/PersonalInformation"
    OPEN_BROKERAGE = "https://digital.fidelity.com/ftgw/digital/aox/BrokerageAccountOpening/JointSelectionPage"

    # Penny Stocks
    PENNY_STOCK_TERMS_1 = "https://digital.fidelity.com/ftgw/digital/easy/hrt/pst/termsandconditions"
    PENNY_STOCK_TERMS_2 = "https://digital.fidelity.com/ftgw/digital/brokerage-host/psta/TermsAndCondtions"


# =============================================================================
# CSS Selectors
# =============================================================================

class Selectors:
    """CSS selectors for page elements."""

    # Loading indicators
    LOADING_SPINNER_1 = "div:nth-child(2) > .loading-spinner-mask-after"
    LOADING_SPINNER_2 = ".pvd-spinner__mask-inner"
    LOADING_SPINNER_3 = "pvd-loading-spinner"
    LOADING_SPINNER_4 = ".pvd3-spinner-root > .pvd-spinner__spinner > .pvd-spinner__visual > div > .pvd-spinner__mask-inner"

    # Login page
    LOGIN_WIDGET = "#dom-widget div"
    TOTP_INPUT = "XXXXXX"  # placeholder text

    # Trading page
    ACCOUNT_DROPDOWN = "#dest-acct-dropdown"
    SYMBOL_INPUT = "Symbol"
    QUOTE_PANEL = "#quote-panel"
    LAST_PRICE = "#eq-ticket__last-price > span.last-price"
    EXTENDED_HOURS_WRAPPER = ".eq-ticket__extendedhour-toggle"
    EXTENDED_HOURS_BUTTON = "#eq-ticket_extendedhour"
    ACTION_DROPDOWN = ".eq-ticket-action-label"
    QUANTITY_INPUT = "#eqt-mts-stock-quatity div"
    ORDER_TYPE_DROPDOWN = "#dest-dropdownlist-button-ordertype > span:nth-child(1)"
    ORDER_TYPE_CONTAINER = "#order-type-container-id"

    # Positions page
    AVAILABLE_ACTIONS_BUTTON = "Available Actions"
    DOWNLOAD_POSITIONS = "Download Positions"

    # Transfer page
    FROM_DROPDOWN = "From"
    TO_DROPDOWN = "To"
    TRANSFER_AMOUNT_INPUT = "#transfer-amount"
    WITHDRAWAL_BALANCE_ROW = "tr.pvd-table__row:nth-child(2) > td:nth-child(2)"

    # Account customization
    CUSTOMIZE_ACCOUNTS = "Customize Accounts"
    CUSTOMIZE_MODAL_ITEM = ".custom-modal__accounts-item"
    CUSTOMIZE_BUTTON_NEW = "ap143528-account-customize-open-button"
    RENAME_INPUT_NEW = "ap143528-account-customize-account-input"

    # Penny stocks
    PENNY_STOCK_CHECKBOX = ".pvd-checkbox__label"

    # Statements
    STATEMENTS_SKELETON = "statements-loading-skeleton div"

    # Common
    CHECKBOX_LABEL = "label"
    DIALOG_CLOSE = "Close dialog"


# =============================================================================
# Regex Patterns
# =============================================================================

class Patterns:
    """Regex patterns used throughout the API."""

    # Account number pattern: Z or digit followed by 6+ digits, within parentheses
    ACCOUNT_NUMBER = r'(?<=\()(Z|\d)\d{6,}(?=\))'

    # Account nickname: everything before the first parenthesis
    ACCOUNT_NICKNAME = r'^.+?(?=\()'


# =============================================================================
# Timeouts (milliseconds)
# =============================================================================

class Timeouts:
    """Default timeout values in milliseconds."""

    DEFAULT = 30_000
    SHORT = 5_000
    MEDIUM = 15_000
    LONG = 60_000
    VERY_LONG = 150_000  # 2.5 minutes

    PAGE_LOAD = 30_000
    LOGIN = 20_000
    DOWNLOAD = 8_000
