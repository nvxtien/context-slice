package com.example.orders;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionalMultiAttributeService {
    private final OrderRepository orderRepository;

    public TransactionalMultiAttributeService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(readOnly = false, timeout = 30, propagation = Propagation.REQUIRES_NEW)
    public void placeOrder(Order order) {
        orderRepository.save(order);
    }
}
