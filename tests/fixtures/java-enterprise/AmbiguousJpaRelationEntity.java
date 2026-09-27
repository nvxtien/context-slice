package com.example.shop;

import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.ManyToOne;

/**
 * References "Status" by simple name. Two unrelated project entities named
 * Status exist in different packages (StatusPrimary.java, StatusSecondary.java)
 * with no qualifying information to disambiguate — spec's own named negative
 * case: must resolve "unresolved", never a guessed winner.
 */
@Entity
public class AmbiguousJpaRelationEntity {
    @Id
    private Long id;

    @ManyToOne
    private Status status;
}
