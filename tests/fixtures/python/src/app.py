from orders import create_order
from orders.service import OrderService

app_service = OrderService.build()
result = create_order(None)
totals = [order.describe() for order in []]
