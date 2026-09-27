package com.example.shop;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import java.util.List;

/** An explicit @Query method, captured verbatim as evidence text (§24), never parsed. */
public interface TechnicianRepository extends JpaRepository<Technician, Long> {
    @Query("SELECT t FROM Technician t WHERE t.active = true")
    List<Technician> findActiveTechnicians();
}
