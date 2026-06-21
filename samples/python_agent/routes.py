"""A Blueprint with a url_prefix, mounted under /api in app.py.

Composed path = register-prefix (/api) + blueprint url_prefix (/users) + route.
"""
from flask import Blueprint, request

from models import UserRequest
from service import persist_user

bp = Blueprint("users", __name__, url_prefix="/users")


@bp.route("/", methods=["POST"])
def create_user():
    payload = UserRequest(**request.get_json())   # best-effort body entity
    return persist_user(payload.name)             # resolves into service (high)


@bp.get("/<int:user_id>")
def get_user(user_id):
    return {"id": user_id}
