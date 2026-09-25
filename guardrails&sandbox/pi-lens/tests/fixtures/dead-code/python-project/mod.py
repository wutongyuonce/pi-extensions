import os  # unused import


def used_func():
    return 1


def unused_func():
    return 2


class UnusedClass:
    pass


print(used_func())


def fixture(func):  # stand-in for pytest.fixture, keeps the fixture dep-free
    return func


@fixture
def framework_called_fixture():
    return 3
