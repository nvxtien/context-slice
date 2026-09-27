package com.example.orders;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class FieldInjectionService {
    @Autowired
    private NotificationGateway notificationGateway;

    public void notifyCustomer(String message) {
        notificationGateway.send(message);
    }
}
