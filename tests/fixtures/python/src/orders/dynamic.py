import importlib
from .service import OrderService


def factory():
    return OrderService


def run_dynamic(name: str):
    obj = factory()
    obj.create(None)
    getattr(obj, name)()
    module = importlib.import_module(name)
    return module


class Patched:
    def run(self):
        return "original"


Patched.run = lambda self: "patched"
