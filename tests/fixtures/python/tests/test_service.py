from orders.service import create_order


def test_create_order():
    assert create_order(None) is not None
