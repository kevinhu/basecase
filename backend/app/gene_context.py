import re
from datetime import UTC, datetime
from time import monotonic
from typing import Any

import httpx

from app.models import (
    GeneExpressionResponse,
    GeneLiteratureResponse,
    LiteratureArticle,
    TissueExpression,
)

PUBTATOR_API_URL = "https://www.ncbi.nlm.nih.gov/research/pubtator3-api"
GTEX_API_URL = "https://gtexportal.org/api/v2"
YEAR_PATTERN = re.compile(r"^(\d{4})")


class GeneContextError(RuntimeError):
    pass


class GeneContextClient:
    def __init__(self) -> None:
        self._literature_cache: dict[str, tuple[float, GeneLiteratureResponse]] = {}
        self._expression_cache: dict[str, tuple[float, GeneExpressionResponse]] = {}

    async def literature(self, symbol: str, limit: int = 5) -> GeneLiteratureResponse:
        normalized_symbol = symbol.strip().upper()
        cached = self._literature_cache.get(normalized_symbol)
        if cached and cached[0] > monotonic():
            return cached[1].model_copy(update={"articles": cached[1].articles[:limit]})

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    f"{PUBTATOR_API_URL}/search/",
                    params={"text": f"@GENE_{normalized_symbol}", "page": 1},
                    headers={"User-Agent": "basecase/0.1"},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise GeneContextError(f"PubTator request failed: {error}") from error

        result = normalize_literature(normalized_symbol, payload)
        self._literature_cache[normalized_symbol] = (monotonic() + 3600, result)
        return result.model_copy(update={"articles": result.articles[:limit]})

    async def expression(self, symbol: str) -> GeneExpressionResponse:
        normalized_symbol = symbol.strip().upper()
        cached = self._expression_cache.get(normalized_symbol)
        if cached and cached[0] > monotonic():
            return cached[1]

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                gene_response = await client.get(
                    f"{GTEX_API_URL}/reference/geneSearch",
                    params={
                        "geneId": normalized_symbol,
                        "gencodeVersion": "v39",
                        "genomeBuild": "GRCh38/hg38",
                    },
                    headers={"User-Agent": "basecase/0.1"},
                )
                gene_response.raise_for_status()
                gene_payload = gene_response.json()
                genes = gene_payload.get("data", [])
                if not isinstance(genes, list) or not genes:
                    raise GeneContextError(f"GTEx has no gene record for {normalized_symbol}")
                gencode_id = str(genes[0].get("gencodeId") or "")
                if not gencode_id:
                    raise GeneContextError(f"GTEx returned no GENCODE ID for {normalized_symbol}")

                expression_response = await client.get(
                    f"{GTEX_API_URL}/expression/medianGeneExpression",
                    params={
                        "gencodeId": gencode_id,
                        "datasetId": "gtex_v10",
                        "itemsPerPage": 100,
                    },
                    headers={"User-Agent": "basecase/0.1"},
                )
                expression_response.raise_for_status()
                expression_payload = expression_response.json()
        except GeneContextError:
            raise
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise GeneContextError(f"GTEx request failed: {error}") from error

        result = normalize_expression(normalized_symbol, gencode_id, expression_payload)
        self._expression_cache[normalized_symbol] = (monotonic() + 3600, result)
        return result


def normalize_literature(symbol: str, payload: dict[str, Any]) -> GeneLiteratureResponse:
    raw_articles = payload.get("results", [])
    if not isinstance(raw_articles, list):
        raw_articles = []
    articles: list[LiteratureArticle] = []
    for raw in raw_articles:
        if not isinstance(raw, dict) or not raw.get("pmid") or not raw.get("title"):
            continue
        date = str(raw.get("date") or "")
        year_match = YEAR_PATTERN.match(date)
        raw_authors = raw.get("authors")
        authors = [str(author) for author in raw_authors] if isinstance(raw_authors, list) else []
        pmid = str(raw["pmid"])
        articles.append(
            LiteratureArticle(
                pmid=pmid,
                title=str(raw["title"]),
                journal=_optional_string(raw.get("journal")),
                year=int(year_match.group(1)) if year_match else None,
                authors=authors,
                doi=_optional_string(raw.get("doi")),
                pmcid=_optional_string(raw.get("pmcid")),
                relevance_score=_optional_float(raw.get("score")),
                source_url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            )
        )

    total = payload.get("count")
    return GeneLiteratureResponse(
        symbol=symbol,
        total=int(total) if isinstance(total, int | float) else len(articles),
        articles=articles,
        retrieved_at=datetime.now(UTC),
    )


def normalize_expression(
    symbol: str,
    gencode_id: str,
    payload: dict[str, Any],
) -> GeneExpressionResponse:
    raw_tissues = payload.get("data", [])
    if not isinstance(raw_tissues, list):
        raw_tissues = []
    tissues = [
        TissueExpression(
            tissue_id=str(raw["tissueSiteDetailId"]),
            tissue_name=tissue_name(str(raw["tissueSiteDetailId"])),
            ontology_id=_optional_string(raw.get("ontologyId")),
            median=float(raw["median"]),
            unit=str(raw.get("unit") or "TPM"),
        )
        for raw in raw_tissues
        if isinstance(raw, dict)
        and raw.get("tissueSiteDetailId")
        and isinstance(raw.get("median"), int | float)
    ]
    tissues.sort(key=lambda tissue: tissue.median, reverse=True)
    return GeneExpressionResponse(
        symbol=symbol,
        dataset_id="gtex_v10",
        gencode_id=gencode_id,
        tissues=tissues,
        retrieved_at=datetime.now(UTC),
    )


def tissue_name(tissue_id: str) -> str:
    parts = tissue_id.split("_")
    if len(parts) <= 1:
        return tissue_id
    return f"{parts[0]} — {' '.join(parts[1:])}"


def _optional_string(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


def _optional_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


gene_context_client = GeneContextClient()
