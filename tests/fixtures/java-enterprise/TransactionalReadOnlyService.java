package com.example.orders;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TransactionalReadOnlyService {
    private final OrderRepository orderRepository;

    public TransactionalReadOnlyService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional(readOnly = true)
    public Order findById(long id) {
        return orderRepository.findById(id);
    }
}
