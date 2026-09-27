package com.example.orders;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

// Two project classes named "PricingEngine" exist (see AmbiguousPricingEnginePrimary.java and
// AmbiguousPricingEngineSecondary.java, in different sub-packages), with no @Qualifier to name
// a candidate. Per §13 this must resolve "unresolved" and never a guessed winner.
@Service
public class AmbiguousBeanService {
    @Autowired
    private PricingEngine pricingEngine;

    public long priceFor(Order order) {
        return pricingEngine.price(order);
    }
}
