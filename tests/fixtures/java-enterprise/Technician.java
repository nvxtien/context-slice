package com.example.shop;

import javax.persistence.Entity;
import javax.persistence.Id;

/** Target of WorkOrder.assignedTechnician (see JpaEntityWithRelations.java). */
@Entity
public class Technician {
    @Id
    private Long id;

    private String name;

    private boolean active;

    public String getName() {
        return name;
    }

    public boolean isActive() {
        return active;
    }
}
