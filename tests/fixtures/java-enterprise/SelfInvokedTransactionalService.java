package com.example.orders;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SelfInvokedTransactionalService {
    private final OrderRepository orderRepository;

    public SelfInvokedTransactionalService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    // Not itself @Transactional. Calls a sibling method on `this` — per Spring's
    // proxy-based AOP, this self-invocation does NOT go through the proxy, so no
    // transactional behavior is actually applied here despite the callee's annotation.
    public Order lookupOrder(long id) {
        return this.findById(id);
    }

    @Transactional(readOnly = true)
    public Order findById(long id) {
        return orderRepository.findById(id);
    }
}
