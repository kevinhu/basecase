import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.agent import AgentError
from app.anthropic_agent import AnthropicAgentError, anthropic_evidence_agent
from app.models import AgentChatRequest, AgentChatResponse
from app.query_engine import QueryEngineError

router = APIRouter(prefix="/api/agent", tags=["Agent"])


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest) -> AgentChatResponse:
    try:
        return await anthropic_evidence_agent.chat(request)
    except (AgentError, AnthropicAgentError, QueryEngineError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/chat/stream")
async def agent_chat_stream(request: AgentChatRequest) -> StreamingResponse:
    events: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def emit(event: dict[str, Any]) -> None:
        await events.put(event)

    async def run() -> None:
        try:
            response = await anthropic_evidence_agent.chat(request, emit)
            await emit({"type": "answer", "data": response.model_dump(mode="json")})
        except (AgentError, AnthropicAgentError, QueryEngineError) as error:
            await emit({"type": "error", "message": str(error)})
        finally:
            await events.put(None)

    task = asyncio.create_task(run())

    async def stream() -> AsyncIterator[str]:
        while True:
            event = await events.get()
            if event is None:
                break
            yield f"{json.dumps(event, separators=(',', ':'))}\n"
        await task

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )
