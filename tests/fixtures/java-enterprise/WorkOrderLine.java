package com.example.shop;

import javax.persistence.Entity;
import javax.persistence.Id;

/** Target of WorkOrder.lines (see JpaEntityWithRelations.java). */
@Entity
public class WorkOrderLine {
    @Id
    private Long id;

    private String partName;

    private int quantity;

    public String getPartName() {
        return partName;
    }

    public int getQuantity() {
        return quantity;
    }
}
