package com.example.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

/** A compound, And-joined derived query (two properties, real word-boundary split). */
public interface WorkOrderLineRepository extends JpaRepository<WorkOrderLine, Long> {
    List<WorkOrderLine> findByPartNameAndQuantity(String partName, int quantity);
}
