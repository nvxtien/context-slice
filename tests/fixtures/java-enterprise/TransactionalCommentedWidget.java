package com.example.orders;

import org.springframework.stereotype.Service;

@Service
public class TransactionalCommentedWidget {
    private final OrderRepository orderRepository;

    public TransactionalCommentedWidget(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    // example: @Transactional(readOnly = true)
    public Order findById(long id) {
        return orderRepository.findById(id);
    }
}
