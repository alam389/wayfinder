import { Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";
import { CreateUserDto } from "./create-user.dto.js";
import { User } from "./user.entity.js";

@Injectable()
export class UsersService {
  // Stand-in for an injected TypeORM repository.
  private readonly repo: Repository<User> = {} as Repository<User>;

  async create(dto: CreateUserDto): Promise<User> {
    const user = new User();
    user.email = dto.email;
    user.name = dto.name;
    return this.repo.save(user);
  }

  async findOne(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }
}
