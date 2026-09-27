package com.example.shop;

import javax.persistence.CascadeType;
import javax.persistence.Entity;
import javax.persistence.FetchType;
import javax.persistence.GeneratedValue;
import javax.persistence.GenerationType;
import javax.persistence.Id;
import javax.persistence.JoinColumn;
import javax.persistence.ManyToOne;
import javax.persistence.OneToMany;
import javax.persistence.Table;
import java.util.List;

/**
 * A repair work order: owns its line items (collection-typed one-to-many,
 * explicit fetch/cascade/@JoinColumn) and is assigned to a single technician
 * (bare many-to-one, no explicit attributes). See WorkOrderLine.java and
 * Technician.java for the two relationship targets.
 */
@Entity
@Table(name = "work_orders")
public class WorkOrder {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToMany(cascade = CascadeType.ALL, fetch = FetchType.LAZY)
    @JoinColumn(name = "work_order_id")
    private List<WorkOrderLine> lines;

    @ManyToOne
    private Technician assignedTechnician;

    private String description;

    public Long getId() {
        return id;
    }

    public List<WorkOrderLine> getLines() {
        return lines;
    }

    public Technician getAssignedTechnician() {
        return assignedTechnician;
    }

    public String getDescription() {
        return description;
    }
}
