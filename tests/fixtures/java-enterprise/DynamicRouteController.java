package com.example.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ApiPaths.BASE_PATH)
public class DynamicRouteController {
    private final OrderService orderService;

    public DynamicRouteController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping("/summary")
    public String summary() {
        return orderService.describe();
    }
}
