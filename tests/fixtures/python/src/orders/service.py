import json
import requests
from .models import Order
from .repo import SqlRepo
from .validation import validate_order as check_order

normalize = lambda value: value.strip()


class OrderService:
    def __init__(self, repo: SqlRepo):
        self.repo = repo
        self.seen = 0

    async def create(self, order: Order) -> str:
        check_order(order)
        self.count()
        return await self.repo.save(order)

    def count(self) -> int:
        self.seen += 1
        return self.seen

    @property
    def total_seen(self) -> int:
        return self.seen

    @classmethod
    def build(cls) -> "OrderService":
        return cls.default()

    @classmethod
    def default(cls) -> "OrderService":
        return cls(SqlRepo("orders"))


def create_order(order: Order) -> str:
    service = OrderService(SqlRepo("orders"))
    service.count()
    payload = json.dumps({"id": order.id})
    requests.post("https://example.test", data=payload)
    return normalize(order.id)


def outer():
    def inner():
        return helper()

    return inner()


def helper():
    return "helper"
