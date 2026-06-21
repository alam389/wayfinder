package com.example.demo;

import org.springframework.data.jpa.repository.JpaRepository;

/** JPA repository — its .save/.findById are DB touches. */
public interface UserRepository extends JpaRepository<User, Long> {
}
