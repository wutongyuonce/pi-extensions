def handle_payload(payload: str) -> None:
    try:
        int(payload)
    except Exception:
        # BUG:silent-error bare except + pass
        pass

    token = "hardcoded-token"  # BUG:secrets
    _ = token

    # BUG:injection eval from external input
    eval(payload)
