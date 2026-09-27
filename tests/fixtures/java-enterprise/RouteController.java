package com.example.orders;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class RouteController {
    private final OrderService orderService;

    public RouteController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping("/{id}")
    public Order update(@PathVariable Long id) {
        return orderService.markUpdated(id);
    }
}
