# Basecase

An evidence-centered genome browser with an agentic research workspace.

## Development

Requirements: [Bun](https://bun.sh/), [uv](https://docs.astral.sh/uv/), and an
Anthropic API key in `.env`.

Install dependencies:

```sh
bun install
uv sync --directory backend
```

Start the frontend and API together:

```sh
bun run dev
```

The evidence agent uses Claude Sonnet 5 at medium effort through Anthropic's Messages API.
Grounded Open Targets and UCSC results are provided to Claude as application context. Set
`ANTHROPIC_API_KEY` in the repository `.env` file.

- Frontend: http://localhost:5173
- API: http://localhost:8000
- API docs: http://localhost:8000/docs

The initial browser opens the hg38 BRCA1 locus with live MANE, GENCODE,
ClinVar, ENCODE cCRE, and phyloP data from UCSC. Use **Add track** to search
other supported UCSC tracks.

Useful checks:

```sh
bun run build
bun run lint
bun run test
```

## Structure

- `frontend/` — Vite, React, TypeScript, TanStack Router, and shadcn/ui
- `backend/` — FastAPI, Pydantic, Ruff, ty, and Python 3.12 managed by uv
