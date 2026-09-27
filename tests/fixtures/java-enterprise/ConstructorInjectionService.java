package com.example.orders;

import org.springframework.stereotype.Service;

@Service
public class ConstructorInjectionService {
    private final OrderRepository orderRepository;

    public ConstructorInjectionService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    public Order lookup(long id) {
        return orderRepository.findById(id);
    }
}
