# Contributing

Bug reports, ideas and pull requests are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.
- By contributing you agree your work is released under the project's [AGPL-3.0 license](LICENSE).

## Run it locally

```bash
# api on :8000
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
DATA_DIR=./data uvicorn app.main:app --reload

# web on :5173, proxies /api and /ws to :8000
cd frontend && npm install && npm run dev
```

Camera, passkeys and push need HTTPS or `localhost`. To try it on a phone, put it behind a tunnel or a reverse
proxy with a real certificate.

## Making changes

- Keep pull requests focused on one thing, and describe what a user would see before and after.
- `npm run build` in `frontend/` must pass (it type-checks).
- `cd backend && pip install -r requirements-dev.txt && python -m pytest` must pass. CI runs it, the frontend
  build and an image smoke test on every pull request. Add a test in `backend/tests/` for API changes.
- App (`app/`): `flutter analyze && flutter test` must pass. Protocol changes go in `docs/e2e.md`, the web's
  `e2e.ts` and `app/lib/e2e.dart` together; CI runs the Dart client against the real backend.
- Say in the PR how you tested on a real device, and include screenshots for UI changes, ideally from a phone.
- API changes: add to `/api/v1` without breaking existing clients. A breaking change needs a new version
  (`/api/v2`) next to the old one. See `backend/app/api.py`.
- Database changes go in `backend/app/db.py`. New tables and indexes: add them to `SCHEMA`. New columns or data
  fixes: append a step to `MIGRATIONS` (never edit or reorder an existing one); `PRAGMA user_version` tracks
  which have run. `tests/test_db.py` checks an old database still upgrades.

## Style

- Python: standard library first, small modules, plain SQL. Formatted to roughly 120 columns.
- TypeScript/React: function components, Tailwind classes, no new UI frameworks.
- UI text is short, lowercase and friendly.
