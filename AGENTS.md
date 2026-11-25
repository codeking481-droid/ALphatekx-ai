# Project instructions

AlphaTekx is a user-owned React/Vite application with a Node.js/Express backend and PostgreSQL. Read `README.md` for local setup, environment, migrations, and deployment notes.

## Conventions

- Keep changes focused and preserve the existing React interface.
- Keep secrets server-side. Never put API keys in `VITE_*` variables.
- Use SQL migrations under `server/db/migrations/`; never silently discard application data.
- Keep backend functionality in domain modules under `server/`.
- Reuse the API client in `src/api/client.js`.
- Run relevant `package.json` checks before finishing code changes.
