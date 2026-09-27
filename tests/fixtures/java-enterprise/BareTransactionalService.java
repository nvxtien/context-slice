package com.example.orders;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BareTransactionalService {
    private final OrderRepository orderRepository;

    public BareTransactionalService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional
    public void cancelOrder(long id) {
        Order order = orderRepository.findById(id);
        order.setStatus("CANCELLED");
        orderRepository.save(order);
    }
}
