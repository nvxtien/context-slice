from .models import Order


def validate_order(order: Order) -> bool:
    return bool(order.id)
