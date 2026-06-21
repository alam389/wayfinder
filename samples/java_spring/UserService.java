package com.example.demo;

import org.springframework.stereotype.Service;

@Service
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /** Writes a new User via the JPA repository → db write on User. */
    public User createUser(CreateUserRequest request) {
        User user = new User();
        // a genuinely unresolved/dynamic call — stays opaque, never invented.
        AuditLog.record("create", user);
        return userRepository.save(user);
    }

    /** Reads a User by id via the JPA repository → db read. */
    public User getUser(Long id) {
        return userRepository.findById(id);
    }
}
