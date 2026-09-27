package com.example.billing;

import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.OneToMany;
import java.math.BigDecimal;
import java.util.List;

/**
 * Inverse side of a bidirectional one-to-many. The owning side
 * (InvoicePayment.invoice, see InvoicePayment.java) carries the @JoinColumn;
 * this side names the owning field via mappedBy only, per §26.
 */
@Entity
public class Invoice {
    @Id
    private Long id;

    @OneToMany(mappedBy = "invoice")
    private List<InvoicePayment> payments;

    private BigDecimal total;

    public List<InvoicePayment> getPayments() {
        return payments;
    }

    public BigDecimal getTotal() {
        return total;
    }
}
