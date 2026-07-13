import asyncio
import os
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

import anthropic
from dotenv import load_dotenv
from pydantic import ValidationError

from app.models import AgentChatRequest, AgentChatResponse, QueryPlan
from app.query_engine import genomic_query_engine, heuristic_plan, reconcile_plan

ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_EFFORT = "medium"
ANTHROPIC_TIMEOUT_SECONDS = 120
BASECASE_ROOT = Path(__file__).resolve().parents[2]
ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]

load_dotenv(BASECASE_ROOT / ".env")

BASE_INSTRUCTIONS = """You are the Basecase genomic evidence agent.
Answer questions about diseases, genes, variants, and genomic ranges using only the
application evidence supplied with each turn. Do not use outside knowledge to add coordinates,
counts, scores, sources, or clinical claims. Preserve every linked gene coordinate and source
URL exactly as supplied. Write no more than three short sentences that directly answer the
question. Never mention more than three gene or variant symbols in the final text, and do not
enumerate the full result set because the application renders linked records separately. Do not
add a heading, bullet list, or separate sources section. This is research support, not medical
advice.
"""

PLANNER_INSTRUCTIONS = """You are the planning layer for a genomic evidence browser.
Convert the user's question and attached browser context into the required typed query plan.
Compose from entities, range operations, evidence capabilities, filters, and output types; do
not answer the question. Supported evidence capabilities are genes, transcripts, clinvar,
regulatory, conservation, and sequence. Use a promoter range only when requested; default to
MANE, 2000 bp upstream and 200 bp downstream. Use an around range for nearby/around questions,
defaulting to 50000 bp. Put tissue or cell wording in filters.biosample. Pathogenic requests
must include both Pathogenic and Likely pathogenic filters. Preserve the supplied assembly.
For attached or deictic context such as this row/range/selection, use a context entity and
context range. Return only the required JSON object.
"""


class AnthropicAgentError(RuntimeError):
    pass


class AnthropicAgentClient:
    def __init__(self, client: Any | None = None) -> None:
        self._client = client
        self._threads: dict[str, list[dict[str, str]]] = {}
        self._thread_locks: dict[str, asyncio.Lock] = {}

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise AnthropicAgentError("ANTHROPIC_API_KEY is not configured")
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key,
            timeout=ANTHROPIC_TIMEOUT_SECONDS,
        )
        return self._client

    async def plan_turn(
        self,
        request: AgentChatRequest,
        on_event: ProgressCallback | None = None,
    ) -> QueryPlan:
        if on_event:
            await on_event(
                {
                    "type": "progress",
                    "stage": "grounding",
                    "message": "Translating the question into a genomic query plan",
                }
            )
        try:
            response = await self._get_client().messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=4096,
                system=PLANNER_INSTRUCTIONS,
                messages=[
                    {
                        "role": "user",
                        "content": request.model_dump_json(exclude={"thread_id"}, indent=2),
                    }
                ],
                output_config={
                    "effort": ANTHROPIC_EFFORT,
                    "format": {
                        "type": "json_schema",
                        "schema": strict_plan_schema(),
                    },
                },
            )
            plan = QueryPlan.model_validate_json(_message_text(response))
        except (anthropic.APIError, ValidationError, ValueError) as error:
            raise AnthropicAgentError("Claude returned an invalid genomic query plan") from error
        if on_event:
            await on_event(
                {
                    "type": "progress",
                    "stage": "grounding",
                    "message": describe_plan(plan),
                }
            )
        return plan

    async def run_turn(
        self,
        thread_id: str | None,
        message: str,
        evidence: AgentChatResponse,
        on_event: ProgressCallback | None = None,
    ) -> tuple[str, str]:
        active_thread_id = thread_id or uuid.uuid4().hex
        history = self._threads.setdefault(active_thread_id, [])
        lock = self._thread_locks.setdefault(active_thread_id, asyncio.Lock())

        async with lock:
            compact_evidence = evidence.model_copy(
                update={
                    "variants": evidence.variants[:20],
                    "features": evidence.features[:20],
                    "genes": evidence.genes[:12],
                }
            )
            evidence_json = compact_evidence.model_dump_json(
                exclude={"thread_id", "backend"},
                indent=2,
            )
            current_prompt = (
                f"Question:\n{message}\n\n"
                "Grounded application evidence (JSON):\n"
                f"{evidence_json}"
            )
            messages = [*history[-12:], {"role": "user", "content": current_prompt}]
            answer_parts: list[str] = []
            reasoning_index = -1

            if on_event:
                await on_event(
                    {
                        "type": "progress",
                        "stage": "reasoning",
                        "message": "Claude is reviewing the grounded evidence",
                    }
                )

            try:
                async with self._get_client().messages.stream(
                    model=ANTHROPIC_MODEL,
                    max_tokens=8192,
                    system=BASE_INSTRUCTIONS,
                    messages=messages,
                    thinking={"type": "adaptive", "display": "summarized"},
                    output_config={"effort": ANTHROPIC_EFFORT},
                ) as stream:
                    async for event in stream:
                        event_type = getattr(event, "type", "")
                        if event_type == "content_block_start":
                            block = getattr(event, "content_block", None)
                            if getattr(block, "type", "") == "thinking":
                                reasoning_index += 1
                                if on_event:
                                    await on_event(
                                        {
                                            "type": "reasoning_part",
                                            "index": reasoning_index,
                                        }
                                    )
                        elif event_type == "content_block_delta":
                            delta = getattr(event, "delta", None)
                            delta_type = getattr(delta, "type", "")
                            if delta_type == "thinking_delta":
                                if reasoning_index < 0:
                                    reasoning_index = 0
                                    if on_event:
                                        await on_event(
                                            {"type": "reasoning_part", "index": reasoning_index}
                                        )
                                thinking = str(getattr(delta, "thinking", ""))
                                if thinking and on_event:
                                    await on_event(
                                        {
                                            "type": "reasoning_delta",
                                            "index": reasoning_index,
                                            "delta": thinking,
                                        }
                                    )
                            elif delta_type == "text_delta":
                                text = str(getattr(delta, "text", ""))
                                if text:
                                    answer_parts.append(text)
                                    if on_event:
                                        await on_event(
                                            {
                                                "type": "answer_delta",
                                                "delta": text,
                                            }
                                        )
                    if not answer_parts:
                        final_message = await stream.get_final_message()
                        answer_parts.append(_message_text(final_message))
            except anthropic.APIError as error:
                raise AnthropicAgentError(f"Claude API request failed: {error.message}") from error

            answer = "".join(answer_parts).strip()
            if not answer:
                raise AnthropicAgentError("Claude completed without an answer")
            history.extend(
                [
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": answer},
                ]
            )
            if len(history) > 12:
                del history[:-12]
            return active_thread_id, answer

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()


class AnthropicProtocol(Protocol):
    async def plan_turn(
        self,
        request: AgentChatRequest,
        on_event: ProgressCallback | None = None,
    ) -> QueryPlan: ...

    async def run_turn(
        self,
        thread_id: str | None,
        message: str,
        evidence: AgentChatResponse,
        on_event: ProgressCallback | None = None,
    ) -> tuple[str, str]: ...


class GroundingAgentProtocol(Protocol):
    async def execute(
        self,
        request: AgentChatRequest,
        plan: QueryPlan,
        on_event: ProgressCallback | None = None,
    ) -> AgentChatResponse: ...


def strict_plan_schema() -> dict[str, Any]:
    return anthropic.transform_schema(QueryPlan.model_json_schema())


def _message_text(message: Any) -> str:
    return "".join(
        str(getattr(block, "text", ""))
        for block in getattr(message, "content", [])
        if getattr(block, "type", "") == "text"
    )


def describe_plan(plan: QueryPlan) -> str:
    subject = plan.entities[0].value if plan.entities else "the attached context"
    evidence = ", ".join(plan.evidence) or "available annotations"
    return f"Planned {plan.range.type} analysis for {subject} using {evidence}"


class AnthropicEvidenceAgent:
    def __init__(
        self,
        anthropic_client: AnthropicProtocol,
        grounding_agent: GroundingAgentProtocol,
    ) -> None:
        self._anthropic_client = anthropic_client
        self._grounding_agent = grounding_agent

    async def chat(
        self,
        request: AgentChatRequest,
        on_event: ProgressCallback | None = None,
    ) -> AgentChatResponse:
        try:
            planned = await self._anthropic_client.plan_turn(request, on_event)
            plan = reconcile_plan(request, planned)
        except AnthropicAgentError:
            plan = heuristic_plan(request)
            if on_event:
                await on_event(
                    {
                        "type": "progress",
                        "stage": "grounding",
                        "message": f"Using validated fallback plan: {describe_plan(plan)}",
                    }
                )
        evidence = await self._grounding_agent.execute(request, plan, on_event)
        if on_event:
            await on_event({"type": "reasoning_part", "index": 0})
            await on_event(
                {
                    "type": "reasoning_delta",
                    "index": 0,
                    "delta": grounded_reasoning_summary(evidence),
                }
            )
            await on_event(
                {
                    "type": "progress",
                    "stage": "reasoning",
                    "message": "Starting the Claude synthesis",
                }
            )
        thread_id, answer = await self._anthropic_client.run_turn(
            request.thread_id,
            request.message,
            evidence,
            on_event,
        )
        grounded = evidence.model_dump(exclude={"thread_id", "backend"})
        grounded.update({"summary": answer})
        return AgentChatResponse(**grounded, thread_id=thread_id, backend="anthropic_api")


def grounded_reasoning_summary(evidence: AgentChatResponse) -> str:
    scope = (
        f"{len(evidence.regions)} attached ranges"
        if len(evidence.regions) > 1
        else evidence.regions[0].label
        if evidence.regions
        else "the resolved query anchor"
    )
    records = []
    if evidence.variants:
        records.append(f"{len(evidence.variants)} returned variants")
    if evidence.features:
        records.append(f"{len(evidence.features)} evidence features")
    if evidence.genes:
        records.append(f"{len(evidence.genes)} linked genes")
    record_text = ", ".join(records) if records else "the available grounded records"
    limitation = (
        " I kept the source limits explicit in the answer."
        if not evidence.result_complete or evidence.caveat
        else " The returned source set was complete for this query."
    )
    return (
        f"I resolved {scope}, compared {record_text}, and prioritized claims supported by "
        f"those linked records.{limitation}"
    )


anthropic_client = AnthropicAgentClient()
anthropic_evidence_agent = AnthropicEvidenceAgent(anthropic_client, genomic_query_engine)
