import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

/** TypeORM-backed user record — detected as an `orm` entity via `@Entity`. */
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  name!: string;
}
