"""App entry: mounts the users router under /api -> composed /api/users/... paths."""
from fastapi import FastAPI

from routes import router

app = FastAPI()
app.include_router(router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok"}
