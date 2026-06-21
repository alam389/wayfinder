import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { CreateUserDto } from "./create-user.dto.js";
import type { User } from "./user.entity.js";
import { UsersService } from "./users.service.js";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @Query("verbose") verbose: string): Promise<User | null> {
    return this.usersService.findOne(id);
  }
}
