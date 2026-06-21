import type { Repository } from "typeorm";
import { User } from "./entity.js";
import type { CreateUserRequest } from "./types.js";

/** Stand-in for an injected TypeORM repository (declared type drives entity detection). */
export const userRepository: Repository<User> = {} as Repository<User>;

/** Event hooks resolved dynamically — the tracer must report this call as `opaque`. */
const hooks: Record<string, (u: User) => void> = {};

export async function createUser(data: CreateUserRequest): Promise<User> {
  const user = new User();
  user.email = data.email;
  user.name = data.name;
  const saved = await userRepository.save(user);
  const event = "created";
  hooks[event]?.(saved); // dynamic dispatch — unresolved on purpose
  return saved;
}

export async function getUser(id: string): Promise<User | null> {
  return userRepository.findOne({ where: { id } });
}
