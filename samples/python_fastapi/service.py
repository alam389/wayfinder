"""Service layer — a function the handler resolves into (high-confidence call)."""
from models import User


def create_user(session, payload):
    user = User(email=payload.email, name=payload.name)
    session.add(user)      # ORM write
    session.commit()       # ORM write
    return user


def get_user(session, user_id):
    return session.query(User).get(user_id)   # ORM read
