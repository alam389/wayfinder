import express, { type Request, type Response } from "express";
import { usersRouter } from "./routes/users.js";

export const app = express();

app.use(express.json());
app.use("/api/users", usersRouter);

// A route registered directly on the app (no mount prefix).
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});
