# Basecase

An evidence-centered genome browser with an agentic research workspace.

## Development

Requirements: [Bun](https://bun.sh/) and [uv](https://docs.astral.sh/uv/).

Install dependencies:

```sh
bun install
uv sync --directory backend
```

Start the frontend and API together:

```sh
bun run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:8000
- API docs: http://localhost:8000/docs

## Structure

- `frontend/` — Vite, React, TypeScript, TanStack Router, and shadcn/ui
- `backend/` — FastAPI, Pydantic, Ruff, ty, and Python 3.12 managed by uv
