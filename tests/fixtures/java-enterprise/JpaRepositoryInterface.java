package com.example.shop;

import org.springframework.data.jpa.repository.JpaRepository;

/** Canonical spec §22 shape: extends JpaRepository<Entity, Id> directly, one derived-query method. */
public interface WorkOrderRepository extends JpaRepository<WorkOrder, Long> {
    WorkOrder findByDescription(String description);
}
