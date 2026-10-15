from service import create_app


def main():
    app = create_app()
    return app is not None
