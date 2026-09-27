package com.example.orders;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

// Two project classes named "Validator" exist (see QualifierValidatorPrimary.java and
// QualifierValidatorSecondary.java, in different sub-packages). Under this phase's resolution
// rule candidates are found BY simple name, so a @Qualifier("Validator") can never break the
// tie — it stays evidence-only and the relation still resolves "unresolved" (see Global
// Constraints / plan §14).
@Service
public class QualifierService {
    private final Validator validator;

    @Autowired
    public QualifierService(@Qualifier("Validator") Validator validator) {
        this.validator = validator;
    }

    public boolean isValid(Order order) {
        return validator.validate(order);
    }
}
