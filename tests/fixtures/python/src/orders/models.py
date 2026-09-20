from dataclasses import dataclass


@dataclass
class Order:
    id: str
    total: float = 0.0

    def describe(self) -> str:
        return f"{self.id}: {self.total}"
