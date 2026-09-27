package com.example.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(BASE)
public class ConstantRouteController {
    static final String BASE = "/api/v2";

    private final OrderService orderService;

    public ConstantRouteController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/ping")
    public String ping() {
        return orderService.ping();
    }
}
