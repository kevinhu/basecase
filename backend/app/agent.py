import asyncio
import re
from collections.abc import Mapping
from typing import Any

import httpx

from app.models import (
    AgentChatRequest,
    AgentChatResponse,
    AgentGeneLink,
    AgentMetric,
    AgentSource,
    GenomicFeature,
    TrackFeaturesResponse,
)
from app.ucsc import ucsc_client

OPEN_TARGETS_GRAPHQL_URL = "https://api.platform.opentargets.org/api/v4/graphql"
DISEASE_PATTERNS = (
    re.compile(r"(?:genes?|targets?)\s+(?:are\s+)?(?:related|associated|linked)\s+to\s+(.+)", re.I),
    re.compile(r"(?:genes?|targets?)\s+for\s+(.+)", re.I),
    re.compile(r"(.+?)\s+(?:genes?|targets?)$", re.I),
)
REGION_WORDS = {"region", "locus", "range", "selected", "selection", "context", "here"}
GENE_TRACKS = ("mane", "ncbiRefSeqCurated", "knownGene")
REGION_TRACKS = (*GENE_TRACKS, "clinvarMain", "cCREregistry", "sequenceContext")

DISEASE_QUERY = """
query DiseaseGenes($query: String!) {
  search(queryString: $query, entityNames: ["disease"], page: {index: 0, size: 1}) {
    hits { id name entity }
  }
}
"""

TARGET_QUERY = """
query DiseaseTargets($id: String!) {
  disease(efoId: $id) {
    id
    name
    associatedTargets(page: {index: 0, size: 12}) {
      rows {
        score
        target {
          id
          approvedSymbol
          approvedName
          genomicLocation { chromosome start end }
        }
      }
    }
  }
}
"""


class AgentError(RuntimeError):
    pass


class EvidenceAgent:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            headers={"User-Agent": "basecase/0.1"},
        )

    async def chat(self, request: AgentChatRequest) -> AgentChatResponse:
        disease = extract_disease(request.message)
        words = set(re.findall(r"[a-z]+", request.message.casefold()))
        if disease:
            return await self.disease_genes(disease, request.assembly)
        if len(request.regions) > 1:
            return await self.multi_region_context(request)
        if request.region and (words & REGION_WORDS or not request.feature):
            return await self.region_context(request)
        if request.region:
            return await self.region_context(request)
        return help_response()

    async def multi_region_context(self, request: AgentChatRequest) -> AgentChatResponse:
        responses = await asyncio.gather(
            *(
                self.region_context(
                    request.model_copy(update={"region": region, "regions": [], "feature": None})
                )
                for region in request.regions
            )
        )
        genes: list[AgentGeneLink] = []
        seen_genes: set[tuple[str, str, int, int]] = set()
        metrics: list[AgentMetric] = []
        sources: list[AgentSource] = []
        seen_sources: set[str] = set()
        summaries: list[str] = []
        for index, response in enumerate(responses, start=1):
            summaries.append(f"Region {index}: {response.summary}")
            metrics.extend(
                AgentMetric(
                    label=f"R{index} · {metric.label}",
                    value=metric.value,
                    tone=metric.tone,
                )
                for metric in response.metrics
            )
            for gene in response.genes:
                key = (gene.symbol, gene.chrom, gene.start, gene.end)
                if key not in seen_genes:
                    seen_genes.add(key)
                    genes.append(gene)
            for source in response.sources:
                if source.url not in seen_sources:
                    seen_sources.add(source.url)
                    sources.append(source)
        return AgentChatResponse(
            kind="region_context",
            title=f"Context for {len(request.regions)} selected regions",
            summary=" ".join(summaries),
            genes=genes,
            metrics=metrics,
            sources=sources,
            caveat=(
                "Each range is analyzed independently against the first 500 records per source. "
                "Comparisons are research support, not medical advice."
            ),
        )

    async def disease_genes(self, query: str, assembly: str) -> AgentChatResponse:
        if assembly != "hg38":
            return AgentChatResponse(
                kind="help",
                title="Disease targets require hg38",
                summary=(
                    "Open Targets genomic locations are GRCh38. Switch to hg38 to link "
                    "targets into the browser."
                ),
            )
        search_data = await self._graphql(DISEASE_QUERY, {"query": query})
        hits = _path(search_data, "search", "hits")
        if not isinstance(hits, list) or not hits:
            return AgentChatResponse(
                kind="disease_genes",
                title=f"No disease match for {query}",
                summary=(
                    "Try a standard disease name, such as breast cancer or hypertrophic "
                    "cardiomyopathy."
                ),
                caveat="Disease names are resolved through the Open Targets ontology search.",
            )
        hit = hits[0]
        disease_id = str(hit.get("id", "")) if isinstance(hit, Mapping) else ""
        target_data = await self._graphql(TARGET_QUERY, {"id": disease_id})
        disease = _path(target_data, "disease")
        if not isinstance(disease, Mapping):
            raise AgentError("Open Targets returned no disease record")
        disease_name = str(disease.get("name") or query)
        rows = _path(disease, "associatedTargets", "rows")
        genes = normalize_target_rows(rows if isinstance(rows, list) else [], assembly)
        return AgentChatResponse(
            kind="disease_genes",
            title=f"Genes associated with {disease_name}",
            summary=(
                f"Open Targets ranks these {len(genes)} genes by integrated genetic, clinical, "
                "literature, and pathway evidence. Select a coordinate to open that gene "
                "in the browser."
            ),
            genes=genes,
            metrics=[
                AgentMetric(label="Disease", value=disease_name),
                AgentMetric(label="Assembly", value="GRCh38"),
            ],
            sources=[
                AgentSource(
                    label="Open Targets Platform",
                    url=f"https://platform.opentargets.org/disease/{disease_id}/associations",
                )
            ],
            caveat=(
                "Association scores prioritize evidence strength; they do not by themselves "
                "establish causality."
            ),
        )

    async def region_context(self, request: AgentChatRequest) -> AgentChatResponse:
        region = request.region
        if not region:
            return help_response()
        span = region.end - region.start
        if span > 5_000_000:
            return AgentChatResponse(
                kind="region_context",
                title="Region is too broad",
                summary="Select or zoom to a region of 5 Mb or less for evidence-level context.",
                metrics=[
                    AgentMetric(label="Current span", value=_format_span(span), tone="warning")
                ],
            )

        results = await asyncio.gather(
            *(
                ucsc_client.features(
                    region.assembly,
                    track_id,
                    region.chrom,
                    region.start,
                    region.end,
                    500,
                )
                for track_id in REGION_TRACKS
            ),
            return_exceptions=True,
        )
        by_track = {
            track_id: result.features
            for track_id, result in zip(REGION_TRACKS, results, strict=True)
            if isinstance(result, TrackFeaturesResponse)
        }
        genes = region_gene_links(by_track, region.assembly)
        variants = by_track.get("clinvarMain", [])
        pathogenic = sum(1 for feature in variants if _is_pathogenic(feature))
        regulatory = len(by_track.get("cCREregistry", []))
        context = by_track.get("sequenceContext", [])
        blacklist = sum(
            1 for feature in context if feature.attributes.get("dataset") == "blacklist"
        )
        duplications = sum(
            1 for feature in context if feature.attributes.get("dataset") == "segmental_duplication"
        )
        repeats = sum(1 for feature in context if feature.attributes.get("dataset") == "repeat")
        locus = f"{region.chrom}:{region.start + 1:,}-{region.end:,}"
        subject = request.feature.label if request.feature else locus
        observations = []
        if genes:
            observations.append(
                f"overlaps {len(genes)} annotated gene{'s' if len(genes) != 1 else ''}"
            )
        if variants:
            observations.append(
                f"contains {len(variants)} ClinVar record{'s' if len(variants) != 1 else ''}"
            )
        if regulatory:
            observations.append(
                f"intersects {regulatory} ENCODE regulatory element{'s' if regulatory != 1 else ''}"
            )
        summary = (
            f"{subject} {', '.join(observations)}."
            if observations
            else f"No gene, ClinVar, or ENCODE cCRE annotations were returned for {subject}."
        )
        return AgentChatResponse(
            kind="region_context",
            title=f"Context for {subject}",
            summary=summary,
            genes=genes,
            metrics=[
                AgentMetric(label="Range", value=locus),
                AgentMetric(label="Span", value=_format_span(span)),
                AgentMetric(
                    label="ClinVar",
                    value=f"{len(variants)} total · {pathogenic} pathogenic/likely pathogenic",
                    tone="warning" if pathogenic else "neutral",
                ),
                AgentMetric(label="Regulatory", value=f"{regulatory} cCREs"),
                AgentMetric(
                    label="Sequence context",
                    value=(
                        f"{repeats} repeats · {duplications} duplications · "
                        f"{blacklist} blacklist"
                    ),
                    tone="warning" if blacklist else "neutral",
                ),
            ],
            sources=[
                AgentSource(label="UCSC Genome Browser", url="https://genome.ucsc.edu/"),
                AgentSource(label="ClinVar", url="https://www.ncbi.nlm.nih.gov/clinvar/"),
                AgentSource(
                    label="ENCODE Registry of cCREs", url="https://screen.encodeproject.org/"
                ),
            ],
            caveat=(
                "Counts reflect the current range and the first 500 records per source. "
                "Absence of an annotation is not evidence of absence."
            ),
        )

    async def _graphql(self, query: str, variables: dict[str, str]) -> dict[str, Any]:
        try:
            response = await self._client.post(
                OPEN_TARGETS_GRAPHQL_URL,
                json={"query": query, "variables": variables},
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise AgentError(f"Open Targets request failed: {error}") from error
        if not isinstance(payload, dict) or payload.get("errors"):
            raise AgentError("Open Targets returned an unexpected response")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise AgentError("Open Targets returned no data")
        return data

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def extract_disease(message: str) -> str | None:
    cleaned = message.strip().rstrip("?.!")
    for pattern in DISEASE_PATTERNS:
        match = pattern.search(cleaned)
        if match:
            disease = re.sub(r"^(?:the|a|an)\s+", "", match.group(1).strip(), flags=re.I)
            if disease and not set(re.findall(r"[a-z]+", disease.casefold())) & REGION_WORDS:
                return disease
    return None


def normalize_target_rows(rows: list[Any], assembly: str) -> list[AgentGeneLink]:
    genes: list[AgentGeneLink] = []
    for row in rows:
        if not isinstance(row, Mapping) or not isinstance(row.get("target"), Mapping):
            continue
        target = row["target"]
        location = target.get("genomicLocation")
        if not isinstance(location, Mapping):
            continue
        chrom = str(location.get("chromosome") or "")
        start = _integer(location.get("start"))
        end = _integer(location.get("end"))
        symbol = str(target.get("approvedSymbol") or "")
        if not chrom or start is None or end is None or not symbol:
            continue
        target_id = str(target.get("id") or symbol)
        genes.append(
            AgentGeneLink(
                id=target_id,
                symbol=symbol,
                name=_optional_text(target.get("approvedName")),
                assembly=assembly,
                chrom=chrom if chrom.startswith("chr") else f"chr{chrom}",
                start=start,
                end=end + 1,
                score=_number(row.get("score")),
                source_url=f"https://platform.opentargets.org/target/{target_id}",
            )
        )
    return genes


def region_gene_links(
    by_track: dict[str, list[GenomicFeature]], assembly: str
) -> list[AgentGeneLink]:
    seen: set[str] = set()
    genes: list[AgentGeneLink] = []
    for track_id in GENE_TRACKS:
        for feature in by_track.get(track_id, []):
            symbol = _gene_symbol(feature)
            if not symbol or symbol.casefold() in seen:
                continue
            seen.add(symbol.casefold())
            genes.append(
                AgentGeneLink(
                    id=feature.id,
                    symbol=symbol,
                    name=_optional_text(feature.attributes.get("description")),
                    assembly=assembly,
                    chrom=feature.chrom,
                    start=feature.start,
                    end=feature.end,
                    source_url=feature.source_url,
                )
            )
    return genes[:12]


def help_response() -> AgentChatResponse:
    return AgentChatResponse(
        kind="help",
        title="Ask about a disease or genomic range",
        summary=(
            "Try “genes related to hypertrophic cardiomyopathy,” or select a range in the ruler "
            "and ask “what is the context for this region?”"
        ),
    )


def _path(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _gene_symbol(feature: GenomicFeature) -> str:
    for key in ("geneSymbol", "hgncSymbol", "gene_name", "geneName", "geneName2"):
        value = str(feature.attributes.get(key) or "").strip()
        if value and value.casefold() != "none" and not value.startswith("ENSG"):
            return value
    label = feature.label.strip()
    if not label or label.casefold() == "none" or label.startswith("ENS"):
        return ""
    return label


def _is_pathogenic(feature: GenomicFeature) -> bool:
    significance = str(feature.attributes.get("clinSign") or "").casefold()
    return "pathogenic" in significance and "conflict" not in significance


def _format_span(span: int) -> str:
    if span >= 1_000_000:
        return f"{span / 1_000_000:.2f} Mb"
    if span >= 1_000:
        return f"{span / 1_000:.1f} kb"
    return f"{span} bp"


def _integer(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_text(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


evidence_agent = EvidenceAgent()
