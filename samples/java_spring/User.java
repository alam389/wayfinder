package com.example.demo;

import javax.persistence.Entity;
import javax.persistence.Id;

/** JPA entity → orm. */
@Entity
public class User {
    @Id
    private Long id;
    private String name;
    private String email;

    public Long getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
}
