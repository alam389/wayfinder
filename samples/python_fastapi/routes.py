"""User routes on an APIRouter(prefix=...), mounted via include_router(prefix=...)."""
from fastapi import APIRouter, Depends

from models import CreateUserRequest, UserResponse
from service import create_user, get_user

router = APIRouter(prefix="/users")


def get_session():
    ...


@router.post("/", response_model=UserResponse, status_code=201)
def create(payload: CreateUserRequest, session=Depends(get_session)):
    user = create_user(session, payload)   # resolves into service.create_user (high)
    notify_external(user)                   # genuinely unresolved -> opaque
    return user


@router.get("/{user_id}", response_model=UserResponse)
def read(user_id: int, verbose: bool = False, session=Depends(get_session)):
    return get_user(session, user_id)       # resolves into service.get_user (high)
