package com.example.demo;

/** Plain DTO (no @Entity) → pojo. */
public class CreateUserRequest {
    private String name;
    private String email;

    public String getName() { return name; }
    public String getEmail() { return email; }
}
