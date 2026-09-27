package com.example.billing;

import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.JoinColumn;
import javax.persistence.ManyToOne;
import java.math.BigDecimal;

/**
 * Owning side of the bidirectional relationship with Invoice (see
 * JpaEntityBidirectional.java): carries the @JoinColumn, no mappedBy.
 */
@Entity
public class InvoicePayment {
    @Id
    private Long id;

    @ManyToOne
    @JoinColumn(name = "invoice_id")
    private Invoice invoice;

    private BigDecimal amount;

    public Invoice getInvoice() {
        return invoice;
    }

    public BigDecimal getAmount() {
        return amount;
    }
}
