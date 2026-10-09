import itertools
import os
import sys
import tempfile
from pathlib import Path

import pytest

# the app reads DATA_DIR at import time, so point it at a scratch dir first
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="kicksnap-test-")
os.environ["STATIC_DIR"] = "/nonexistent"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import limits  # noqa: E402
from app.main import app  # noqa: E402

_names = itertools.count()


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def no_rate_limits():
    limits._hits.clear()
    yield


class User:
    """A signed-in device using a bearer token, the way a native app would."""

    def __init__(self, client: TestClient, name: str, token: str):
        self.c, self.name, self.token = client, name, token
        self.h = {"Authorization": f"Bearer {token}"}

    def get(self, path, **kw):
        return self.c.get(path, headers=self.h, **kw)

    def post(self, path, **kw):
        return self.c.post(path, headers=self.h, **kw)

    def delete(self, path, **kw):
        return self.c.request("DELETE", path, headers=self.h, **kw)


@pytest.fixture
def new_user(client):
    def make(prefix="user") -> User:
        r = client.post("/api/v1/devices/new", headers={"X-Kicksnap-Auth": "bearer"})
        assert r.status_code == 200, r.text
        token = r.json()["token"]
        name = f"{prefix}{next(_names)}"
        u = User(client, name, token)
        r = u.post("/api/v1/me/name", json={"username": name})
        assert r.status_code == 200, r.text
        return u

    return make


@pytest.fixture
def friends(new_user):
    def make(a: User = None, b: User = None):
        a, b = a or new_user(), b or new_user()
        assert a.post("/api/v1/friends", json={"username": b.name}).json()["status"] == "requested"
        assert b.post("/api/v1/friends", json={"username": a.name}).json()["status"] == "friends"
        return a, b

    return make
