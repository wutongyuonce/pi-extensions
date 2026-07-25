from auth.service import TokenManager, validate_token


def main():
    manager = TokenManager()
    return validate_token(manager.issue())
