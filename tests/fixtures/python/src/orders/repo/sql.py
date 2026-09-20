from ..models import Order


class SqlRepo:
    def __init__(self, table: str):
        self.table = table

    async def save(self, order: Order) -> str:
        return self._key(order.id)

    def _key(self, order_id: str) -> str:
        return f"{self.table}-{order_id}"

    @staticmethod
    def dialect() -> str:
        return "sqlite"
