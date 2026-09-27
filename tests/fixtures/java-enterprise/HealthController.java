package com.example.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    private final String status = "ok";

    @GetMapping("/health")
    public String health() {
        return status;
    }
}
