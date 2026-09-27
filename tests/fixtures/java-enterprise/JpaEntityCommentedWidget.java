package com.example.shop;

/**
 * Not an entity: @Entity and @OneToMany only appear in comments, never as
 * real annotations. Must produce zero ENTITY_RELATIONs.
 */
public class JpaEntityCommentedWidget {
    // @Entity
    // @OneToMany
    private String note;

    public String getNote() {
        return note;
    }
}
