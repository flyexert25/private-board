from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "board.db"
USERS_PATH = DATA_DIR / "users.json"
SESSION_TTL_SECONDS = 60 * 60 * 12
PBKDF2_ITERATIONS = 240_000
COOKIE_NAME = "board_session"
DB_LOCK = threading.Lock()
SESSIONS: dict[str, dict[str, Any]] = {}

DEFAULT_USERS = [
    {"login": "owner", "name": "Owner", "password": "change-me-owner"},
    {"login": "friend", "name": "Friend", "password": "change-me-friend"},
]


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(exist_ok=True)


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"{PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    iterations_raw, salt_raw, digest_raw = encoded.split("$", maxsplit=2)
    salt = base64.b64decode(salt_raw.encode())
    expected = base64.b64decode(digest_raw.encode())
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations_raw))
    return hmac.compare_digest(actual, expected)


def ensure_users_file() -> None:
    if USERS_PATH.exists():
      return

    users = []
    for user in DEFAULT_USERS:
        users.append(
            {
                "login": user["login"],
                "name": user["name"],
                "password_hash": hash_password(user["password"]),
            }
        )

    USERS_PATH.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def load_users() -> list[dict[str, Any]]:
    return json.loads(USERS_PATH.read_text(encoding="utf-8"))


def save_users(users: list[dict[str, Any]]) -> None:
    USERS_PATH.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_database() -> None:
    ensure_data_dir()
    ensure_users_file()

    with DB_LOCK:
        connection = sqlite3.connect(DB_PATH)
        connection.row_factory = sqlite3.Row
        connection.executescript(
            """
            pragma journal_mode = wal;

            create table if not exists columns (
              id integer primary key autoincrement,
              title text not null,
              position integer not null
            );

            create table if not exists cards (
              id integer primary key autoincrement,
              column_id integer not null references columns(id) on delete cascade,
              title text not null,
              description text not null default '',
              position integer not null,
              created_by text not null
            );
            """
        )

        existing_columns = connection.execute("select count(*) from columns").fetchone()[0]
        if existing_columns == 0:
            connection.executemany(
                "insert into columns(title, position) values(?, ?)",
                [
                    ("Идеи", 0),
                    ("В работе", 1),
                    ("Готово", 2),
                ],
            )

        connection.commit()
        connection.close()


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("pragma foreign_keys = on")
    return connection


def read_board() -> dict[str, Any]:
    with DB_LOCK:
        connection = get_connection()
        columns = [dict(row) for row in connection.execute("select id, title, position from columns order by position, id")]
        cards = [dict(row) for row in connection.execute("select id, column_id, title, description, position, created_by from cards order by position, id")]
        connection.close()

    mapped = []
    for column in columns:
        mapped.append(
            {
                "id": column["id"],
                "title": column["title"],
                "position": column["position"],
                "cards": [
                    {
                        "id": card["id"],
                        "title": card["title"],
                        "description": card["description"],
                        "position": card["position"],
                        "createdBy": card["created_by"],
                    }
                    for card in cards
                    if card["column_id"] == column["id"]
                ],
            }
        )

    return {"columns": mapped}


def create_column(title: str) -> None:
    with DB_LOCK:
        connection = get_connection()
        max_position = connection.execute("select coalesce(max(position), -1) from columns").fetchone()[0]
        connection.execute("insert into columns(title, position) values(?, ?)", (title, max_position + 1))
        connection.commit()
        connection.close()


def delete_column(column_id: int) -> None:
    with DB_LOCK:
        connection = get_connection()
        connection.execute("delete from columns where id = ?", (column_id,))
        connection.commit()
        connection.close()


def create_card(column_id: int, title: str, description: str, created_by: str) -> None:
    with DB_LOCK:
        connection = get_connection()
        max_position = connection.execute(
            "select coalesce(max(position), -1) from cards where column_id = ?",
            (column_id,),
        ).fetchone()[0]
        connection.execute(
            "insert into cards(column_id, title, description, position, created_by) values(?, ?, ?, ?, ?)",
            (column_id, title, description, max_position + 1, created_by),
        )
        connection.commit()
        connection.close()


def move_card(card_id: int, column_id: int) -> None:
    with DB_LOCK:
        connection = get_connection()
        max_position = connection.execute(
            "select coalesce(max(position), -1) from cards where column_id = ?",
            (column_id,),
        ).fetchone()[0]
        connection.execute(
            "update cards set column_id = ?, position = ? where id = ?",
            (column_id, max_position + 1, card_id),
        )
        connection.commit()
        connection.close()


def delete_card(card_id: int) -> None:
    with DB_LOCK:
        connection = get_connection()
        connection.execute("delete from cards where id = ?", (card_id,))
        connection.commit()
        connection.close()


def cleanup_sessions() -> None:
    now = time.time()
    expired = [session_id for session_id, payload in SESSIONS.items() if payload["expires_at"] < now]
    for session_id in expired:
        SESSIONS.pop(session_id, None)


def create_session(login: str) -> str:
    cleanup_sessions()
    session_id = secrets.token_urlsafe(32)
    SESSIONS[session_id] = {
        "login": login,
        "expires_at": time.time() + SESSION_TTL_SECONDS,
    }
    return session_id


def get_user_by_login(login: str) -> dict[str, Any] | None:
    for user in load_users():
        if user["login"] == login:
            return user
    return None


def authenticate(login: str, password: str) -> dict[str, Any] | None:
    user = get_user_by_login(login)
    if not user:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return {"login": user["login"], "name": user["name"]}


def get_session_user(cookie_header: str | None) -> dict[str, Any] | None:
    cleanup_sessions()
    if not cookie_header:
        return None

    cookie = SimpleCookie()
    cookie.load(cookie_header)
    morsel = cookie.get(COOKIE_NAME)
    if not morsel:
        return None

    session_id = morsel.value
    payload = SESSIONS.get(session_id)
    if not payload:
        return None

    user = get_user_by_login(payload["login"])
    if not user:
        return None

    payload["expires_at"] = time.time() + SESSION_TTL_SECONDS
    return {"login": user["login"], "name": user["name"]}


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/session":
            self.handle_session()
            return
        if parsed.path == "/api/board":
            self.handle_get_board()
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/login":
            self.handle_login()
            return
        if parsed.path == "/api/logout":
            self.handle_logout()
            return
        if parsed.path == "/api/columns":
            self.handle_create_column()
            return
        if parsed.path == "/api/cards":
            self.handle_create_card()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/columns/"):
            self.handle_delete_column(int(parsed.path.rsplit("/", maxsplit=1)[-1]))
            return
        if parsed.path.startswith("/api/cards/"):
            self.handle_delete_card(int(parsed.path.rsplit("/", maxsplit=1)[-1]))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/cards/"):
            self.handle_move_card(int(parsed.path.rsplit("/", maxsplit=1)[-1]))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_session(self) -> None:
        user = get_session_user(self.headers.get("Cookie"))
        self.send_json({"user": user})

    def handle_login(self) -> None:
        payload = self.read_json()
        login = str(payload.get("login", "")).strip()
        password = str(payload.get("password", ""))
        user = authenticate(login, password)

        if not user:
            self.send_json({"error": "Неверный логин или пароль."}, status=HTTPStatus.UNAUTHORIZED)
            return

        session_id = create_session(user["login"])
        self.send_json(
            {"user": user},
            cookies=[self.build_cookie(COOKIE_NAME, session_id, max_age=SESSION_TTL_SECONDS)],
        )

    def handle_logout(self) -> None:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(COOKIE_NAME)
        if morsel:
            SESSIONS.pop(morsel.value, None)
        self.send_json({"ok": True}, cookies=[self.build_cookie(COOKIE_NAME, "", max_age=0)])

    def handle_get_board(self) -> None:
        user = self.require_auth()
        if not user:
            return
        self.send_json(read_board())

    def handle_create_column(self) -> None:
        user = self.require_auth()
        if not user:
            return
        payload = self.read_json()
        title = str(payload.get("title", "")).strip()
        if not title:
            self.send_json({"error": "Название колонки обязательно."}, status=HTTPStatus.BAD_REQUEST)
            return
        create_column(title)
        self.send_json({"ok": True}, status=HTTPStatus.CREATED)

    def handle_delete_column(self, column_id: int) -> None:
        user = self.require_auth()
        if not user:
            return
        delete_column(column_id)
        self.send_json({"ok": True})

    def handle_create_card(self) -> None:
        user = self.require_auth()
        if not user:
            return
        payload = self.read_json()
        column_id = int(payload.get("columnId", 0))
        title = str(payload.get("title", "")).strip()
        description = str(payload.get("description", "")).strip()
        if not column_id or not title:
            self.send_json({"error": "Нужны колонка и название карточки."}, status=HTTPStatus.BAD_REQUEST)
            return
        create_card(column_id, title, description, user["login"])
        self.send_json({"ok": True}, status=HTTPStatus.CREATED)

    def handle_move_card(self, card_id: int) -> None:
        user = self.require_auth()
        if not user:
            return
        payload = self.read_json()
        column_id = int(payload.get("columnId", 0))
        if not column_id:
            self.send_json({"error": "Не указана целевая колонка."}, status=HTTPStatus.BAD_REQUEST)
            return
        move_card(card_id, column_id)
        self.send_json({"ok": True})

    def handle_delete_card(self, card_id: int) -> None:
        user = self.require_auth()
        if not user:
            return
        delete_card(card_id)
        self.send_json({"ok": True})

    def require_auth(self) -> dict[str, Any] | None:
        user = get_session_user(self.headers.get("Cookie"))
        if user:
            return user
        self.send_json({"error": "Нужен вход в систему."}, status=HTTPStatus.UNAUTHORIZED)
        return None

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK, cookies: list[str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def build_cookie(self, name: str, value: str, max_age: int) -> str:
        parts = [
            f"{name}={value}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            f"Max-Age={max_age}",
        ]
        return "; ".join(parts)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def reset_password(login: str) -> str:
    users = load_users()
    for user in users:
        if user["login"] == login:
            new_password = secrets.token_urlsafe(12)
            user["password_hash"] = hash_password(new_password)
            save_users(users)
            return new_password
    raise ValueError(f"Пользователь {login} не найден")


def set_password(login: str, password: str) -> None:
    users = load_users()
    for user in users:
        if user["login"] == login:
            user["password_hash"] = hash_password(password)
            save_users(users)
            return
    raise ValueError(f"Пользователь {login} не найден")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reset-password")
    parser.add_argument("--set-password", nargs=2, metavar=("LOGIN", "PASSWORD"))
    args = parser.parse_args()

    ensure_database()

    if args.reset_password:
        new_password = reset_password(args.reset_password)
        print(f"{args.reset_password}: {new_password}")
        return

    if args.set_password:
        login, password = args.set_password
        set_password(login, password)
        print(f"{login}: password updated")
        return

    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Server started on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
