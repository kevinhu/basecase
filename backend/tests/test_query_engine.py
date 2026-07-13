import pytest

from app.agent import evidence_agent
from app.models import (
    AgentChatRequest,
    AgentRegion,
    GeneSearchResponse,
    GeneSearchResult,
    GenomicFeature,
    QueryEntity,
    QueryFilters,
    QueryPlan,
    QueryRangeExpression,
    TrackFeaturesResponse,
)
from app.query_engine import (
    GenomicQueryEngine,
    heuristic_plan,
    parse_vcf_region,
    reconcile_plan,
    source_records,
)
from app.ucsc import ucsc_client


def test_source_records_deduplicate_shared_urls() -> None:
    records = source_records(["genes", "conservation", "sequence"])

    assert [record.url for record in records] == ["https://genome.ucsc.edu/"]


@pytest.mark.parametrize(
    ("question", "entity_type", "range_type", "evidence"),
    [
        (
            "BRCA1 promoter pathogenic variants in hg38",
            "gene",
            "promoter",
            {"clinvar"},
        ),
        (
            "rs334 nearby enhancers in blood cells",
            "variant",
            "around",
            {"regulatory"},
        ),
        (
            "TP53 ClinVar + conservation + transcripts",
            "gene",
            "gene",
            {"clinvar", "conservation", "transcripts"},
        ),
    ],
)
def test_heuristic_plan_composes_query_primitives(
    question: str,
    entity_type: str,
    range_type: str,
    evidence: set[str],
) -> None:
    plan = heuristic_plan(AgentChatRequest(message=question, assembly="hg38"))

    assert plan.entities[0].type == entity_type
    assert plan.range.type == range_type
    assert evidence.issubset(set(plan.evidence))


def test_vcf_row_parses_one_based_position_and_reference_span() -> None:
    region = parse_vcf_region("chr11 5227002 rs334 A T", "hg38")

    assert region == AgentRegion(
        assembly="hg38",
        chrom="chr11",
        start=5227001,
        end=5227002,
    )


def test_explicit_entity_overrides_ambient_context_plan() -> None:
    request = AgentChatRequest(
        message="TP53 ClinVar + conservation + transcripts",
        assembly="hg38",
        region=AgentRegion(assembly="hg38", chrom="chr17", start=100, end=200),
    )
    ambient_plan = QueryPlan(
        intent="genomic_evidence",
        assembly="hg38",
        entities=[QueryEntity(type="context", value="attached viewport")],
        range=QueryRangeExpression(type="context"),
        evidence=["clinvar"],
        filters=QueryFilters(),
        output="summary",
    )

    plan = reconcile_plan(request, ambient_plan)

    assert plan.entities == [QueryEntity(type="gene", value="TP53")]
    assert plan.range.type == "gene"
    assert set(plan.evidence) == {"clinvar", "conservation", "transcripts"}


@pytest.mark.anyio
async def test_promoter_resolution_is_strand_aware(monkeypatch: pytest.MonkeyPatch) -> None:
    async def search_genes(assembly: str, query: str) -> GeneSearchResponse:
        return GeneSearchResponse(
            query=query,
            assembly=assembly,
            results=[
                GeneSearchResult(
                    id="BRCA1",
                    symbol="BRCA1",
                    assembly="hg38",
                    chrom="chr17",
                    start=43044294,
                    end=43125364,
                    source_track="mane",
                )
            ],
        )

    async def features(
        assembly: str,
        track_id: str,
        chrom: str,
        start: int,
        end: int,
        max_items: int,
    ) -> TrackFeaturesResponse:
        return TrackFeaturesResponse(
            assembly=assembly,
            track_id=track_id,
            chrom=chrom,
            start=start,
            end=end,
            retrieved_at="2026-01-01T00:00:00Z",
            truncated=False,
            features=[
                GenomicFeature(
                    id="ENST1",
                    track_id="mane",
                    assembly="hg38",
                    chrom="chr17",
                    start=43044294,
                    end=43125364,
                    label="BRCA1",
                    strand="-",
                )
            ],
        )

    monkeypatch.setattr(ucsc_client, "search_genes", search_genes)
    monkeypatch.setattr(ucsc_client, "features", features)
    engine = GenomicQueryEngine(fallback_agent=evidence_agent)
    plan = QueryPlan(
        intent="genomic_evidence",
        assembly="hg38",
        entities=[QueryEntity(type="gene", value="BRCA1")],
        range=QueryRangeExpression(type="promoter", upstream_bp=2000, downstream_bp=200),
        evidence=["clinvar"],
        filters=QueryFilters(),
        output="variant_table",
    )

    ranges, assumptions, anchor = await engine._resolve_ranges(
        AgentChatRequest(message="BRCA1 promoter variants", assembly="hg38"), plan
    )

    assert anchor == 43125364
    assert ranges[0].start == 43125164
    assert ranges[0].end == 43127364
    assert {item.label for item in assumptions} == {"Transcript", "Promoter definition"}
