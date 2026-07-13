from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

from app.agent import evidence_agent
from app.agent_routes import router as agent_router
from app.anthropic_agent import anthropic_client
from app.gene_routes import router as gene_router
from app.mygene import mygene_client
from app.routes import router as ucsc_router
from app.ucsc import ucsc_client


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    await anthropic_client.close()
    await evidence_agent.close()
    await mygene_client.close()
    await ucsc_client.close()

app = FastAPI(
    title="Basecase API",
    description="Backend for the Basecase genomic evidence workspace.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1_000, compresslevel=5)
app.include_router(ucsc_router)
app.include_router(gene_router)
app.include_router(agent_router)


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="basecase-api")
