/** Request/response shapes (plain interfaces → `interface` entities). */
export interface CreateUserRequest {
  email: string;
  name: string;
}

export interface UserResponse {
  id: number;
  email: string;
  name: string;
}
