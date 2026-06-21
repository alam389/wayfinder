import { type Request, type Response, Router } from "express";
import { CreateUserRequest, UserResponse } from "../types.js";
import { createUser, getUser } from "../userService.js";

export const usersRouter = Router();

// POST /api/users  (mount prefix applied in app.ts)
usersRouter.post(
  "/",
  async (req: Request<{}, UserResponse, CreateUserRequest>, res: Response) => {
    const created = await createUser(req.body);
    res.status(201).json(created);
  },
);

// GET /api/users/:id
usersRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const verbose = req.query.verbose;
  const user = await getUser(id);
  res.json({ user, verbose });
});
