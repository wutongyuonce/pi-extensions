class TokenManager:
    def issue(self):
        return "token"


def validate_token(value):
    return value == "token"
