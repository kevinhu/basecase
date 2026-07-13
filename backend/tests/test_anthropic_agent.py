from types import SimpleNamespace
from typing import Any

import pytest

from app.anthropic_agent import (
    ANTHROPIC_EFFORT,
    ANTHROPIC_MODEL,
    AnthropicAgentClient,
    AnthropicEvidenceAgent,
    ProgressCallback,
    strict_plan_schema,
)
from app.models import (
    AgentChatRequest,
    AgentChatResponse,
    QueryFilters,
    QueryPlan,
    QueryRangeExpression,
)


class FakeStream:
    def __init__(self, events: list[Any]) -> None:
        self._events = events

    async def __aenter__(self) -> "FakeStream":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    def __aiter__(self) -> "FakeStream":
        self._iterator = iter(self._events)
        return self

    async def __anext__(self) -> Any:
        try:
            return next(self._iterator)
        except StopIteration as error:
            raise StopAsyncIteration from error


class FakeMessages:
    def __init__(self, plan: QueryPlan) -> None:
        self.plan = plan
        self.create_kwargs: dict[str, Any] = {}
        self.stream_kwargs: dict[str, Any] = {}

    async def create(self, **kwargs: Any) -> Any:
        self.create_kwargs = kwargs
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self.plan.model_dump_json())]
        )

    def stream(self, **kwargs: Any) -> FakeStream:
        self.stream_kwargs = kwargs
        return FakeStream(
            [
                SimpleNamespace(
                    type="content_block_start",
                    content_block=SimpleNamespace(type="thinking"),
                ),
                SimpleNamespace(
                    type="content_block_delta",
                    delta=SimpleNamespace(type="thinking_delta", thinking="Compared evidence."),
                ),
                SimpleNamespace(
                    type="content_block_delta",
                    delta=SimpleNamespace(type="text_delta", text="Grounded answer"),
                ),
            ]
        )


class FakeClient:
    def __init__(self, plan: QueryPlan) -> None:
        self.messages = FakeMessages(plan)

    async def close(self) -> None:
        return None


def context_plan() -> QueryPlan:
    return QueryPlan(
        intent="genomic_evidence",
        assembly="hg38",
        range=QueryRangeExpression(type="context"),
        filters=QueryFilters(),
        output="summary",
    )


@pytest.mark.anyio
async def test_anthropic_client_uses_sonnet_5_medium_and_streams_reasoning() -> None:
    fake = FakeClient(context_plan())
    client = AnthropicAgentClient(fake)
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    thread_id, answer = await client.run_turn(
        None,
        "Explain this locus",
        AgentChatResponse(kind="help", title="Evidence", summary="Grounded context"),
        emit,
    )

    assert thread_id
    assert answer == "Grounded answer"
    assert fake.messages.stream_kwargs["model"] == ANTHROPIC_MODEL
    assert fake.messages.stream_kwargs["output_config"] == {"effort": ANTHROPIC_EFFORT}
    assert fake.messages.stream_kwargs["thinking"] == {
        "type": "adaptive",
        "display": "summarized",
    }
    assert {"type": "reasoning_part", "index": 0} in events
    assert {
        "type": "reasoning_delta",
        "index": 0,
        "delta": "Compared evidence.",
    } in events
    assert {"type": "answer_delta", "delta": "Grounded answer"} in events


@pytest.mark.anyio
async def test_anthropic_planner_uses_structured_output() -> None:
    fake = FakeClient(context_plan())
    client = AnthropicAgentClient(fake)

    plan = await client.plan_turn(
        AgentChatRequest(message="Explain this locus", assembly="hg38")
    )

    assert plan.intent == "genomic_evidence"
    assert fake.messages.create_kwargs["model"] == ANTHROPIC_MODEL
    assert fake.messages.create_kwargs["output_config"]["effort"] == ANTHROPIC_EFFORT
    assert fake.messages.create_kwargs["output_config"]["format"]["type"] == "json_schema"


def test_plan_schema_is_strict_for_every_object() -> None:
    schema = strict_plan_schema()

    def keys(value: Any) -> list[str]:
        if isinstance(value, dict):
            return [*value, *(key for child in value.values() for key in keys(child))]
        if isinstance(value, list):
            return [key for child in value for key in keys(child)]
        return []

    assert schema["additionalProperties"] is False
    for definition in schema["$defs"].values():
        assert definition["additionalProperties"] is False
    assert "minimum" not in keys(schema)
    assert "maximum" not in keys(schema)


class FakeGroundingAgent:
    async def execute(
        self,
        request: AgentChatRequest,
        plan: QueryPlan,
        on_event: ProgressCallback | None = None,
    ) -> AgentChatResponse:
        assert request.message
        assert plan.intent == "genomic_evidence"
        return AgentChatResponse(kind="help", title="Evidence", summary="Grounded context")


class FakeAnthropicAdapter:
    async def plan_turn(
        self,
        request: AgentChatRequest,
        on_event: ProgressCallback | None = None,
    ) -> QueryPlan:
        return context_plan()

    async def run_turn(
        self,
        thread_id: str | None,
        message: str,
        evidence: AgentChatResponse,
        on_event: ProgressCallback | None = None,
    ) -> tuple[str, str]:
        assert thread_id == "existing-thread"
        assert message == "Explain this locus"
        assert evidence.title == "Evidence"
        if on_event:
            await on_event(
                {"type": "progress", "stage": "reasoning", "message": "Drafting answer"}
            )
        return "existing-thread", "Explanation"


@pytest.mark.anyio
async def test_anthropic_evidence_agent_returns_thread_and_backend() -> None:
    agent = AnthropicEvidenceAgent(FakeAnthropicAdapter(), FakeGroundingAgent())
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    response = await agent.chat(
        AgentChatRequest(
            message="Explain this locus",
            assembly="hg38",
            thread_id="existing-thread",
        ),
        emit,
    )

    assert response.thread_id == "existing-thread"
    assert response.backend == "anthropic_api"
    assert response.title == "Evidence"
    assert [event["message"] for event in events if event["type"] == "progress"] == [
        "Starting the Claude synthesis",
        "Drafting answer",
    ]
