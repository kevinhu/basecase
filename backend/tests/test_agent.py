import httpx
import pytest

from app.agent import EvidenceAgent, extract_disease, normalize_target_rows
from app.models import AgentChatRequest, AgentChatResponse, AgentGeneLink, AgentMetric, AgentRegion


def test_extract_disease_from_natural_questions() -> None:
    assert extract_disease("Which genes are related to breast cancer?") == "breast cancer"
    assert extract_disease("genes for hypertrophic cardiomyopathy") == "hypertrophic cardiomyopathy"
    assert extract_disease("What is the context for this region?") is None


def test_normalize_target_rows_links_grch38_ranges() -> None:
    genes = normalize_target_rows(
        [
            {
                "score": 0.91,
                "target": {
                    "id": "ENSG00000012048",
                    "approvedSymbol": "BRCA1",
                    "approvedName": "BRCA1 DNA repair associated",
                    "genomicLocation": {
                        "chromosome": "17",
                        "start": 43044292,
                        "end": 43170245,
                    },
                },
            }
        ],
        "hg38",
    )

    assert len(genes) == 1
    assert genes[0].symbol == "BRCA1"
    assert genes[0].chrom == "chr17"
    assert genes[0].start == 43044292
    assert genes[0].end == 43170246
    assert genes[0].score == 0.91


@pytest.mark.anyio
async def test_disease_genes_uses_resolved_disease_and_targets() -> None:
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        payload = request.read().decode()
        if "DiseaseGenes" in payload:
            return httpx.Response(
                200,
                json={
                    "data": {
                        "search": {
                            "hits": [
                                {
                                    "id": "MONDO_0007254",
                                    "name": "breast cancer",
                                    "entity": "disease",
                                }
                            ]
                        }
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "data": {
                    "disease": {
                        "id": "MONDO_0007254",
                        "name": "breast cancer",
                        "associatedTargets": {
                            "rows": [
                                {
                                    "score": 0.9,
                                    "target": {
                                        "id": "ENSG1",
                                        "approvedSymbol": "BRCA1",
                                        "approvedName": "BRCA1 DNA repair associated",
                                        "genomicLocation": {
                                            "chromosome": "17",
                                            "start": 100,
                                            "end": 200,
                                        },
                                    },
                                }
                            ]
                        },
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        agent = EvidenceAgent(http_client)
        response = await agent.disease_genes("breast cancer", "hg38")

    assert response.kind == "disease_genes"
    assert response.title == "Genes associated with breast cancer"
    assert response.genes[0].symbol == "BRCA1"
    assert request_count == 2


class StubRegionAgent(EvidenceAgent):
    async def region_context(self, request: AgentChatRequest) -> AgentChatResponse:
        assert request.region
        symbol = "GENE1" if request.region.start == 100 else "GENE2"
        return AgentChatResponse(
            kind="region_context",
            title=f"Context for {request.region.start}",
            summary=f"{symbol} overlaps this range.",
            genes=[
                AgentGeneLink(
                    id=symbol,
                    symbol=symbol,
                    assembly="hg38",
                    chrom="chr1",
                    start=request.region.start,
                    end=request.region.end,
                )
            ],
            metrics=[AgentMetric(label="Range", value=str(request.region.start))],
        )


@pytest.mark.anyio
async def test_multi_region_context_keeps_each_regions_evidence() -> None:
    agent = StubRegionAgent()
    request = AgentChatRequest(
        message="Compare the selected regions",
        regions=[
            AgentRegion(assembly="hg38", chrom="chr1", start=100, end=200),
            AgentRegion(assembly="hg38", chrom="chr1", start=300, end=400),
        ],
    )

    response = await agent.chat(request)

    assert response.title == "Context for 2 selected regions"
    assert [gene.symbol for gene in response.genes] == ["GENE1", "GENE2"]
    assert [metric.label for metric in response.metrics] == ["R1 · Range", "R2 · Range"]
    await agent.close()
