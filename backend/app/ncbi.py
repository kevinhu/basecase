from datetime import UTC, datetime
from time import monotonic
from typing import Any

import httpx

from app.models import GeneSummaryResponse

NCBI_EUTILS_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


class NCBIError(RuntimeError):
    pass


class NCBIClient:
    def __init__(self, base_url: str = NCBI_EUTILS_URL) -> None:
        self.base_url = base_url.rstrip("/")
        self._cache: dict[str, tuple[float, GeneSummaryResponse]] = {}

    async def gene_summary(self, symbol: str) -> GeneSummaryResponse:
        normalized_symbol = symbol.strip().upper()
        cached = self._cache.get(normalized_symbol)
        if cached and cached[0] > monotonic():
            return cached[1]

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                search_response = await client.get(
                    f"{self.base_url}/esearch.fcgi",
                    params={
                        "db": "gene",
                        "term": f"{normalized_symbol}[sym] AND Homo sapiens[orgn]",
                        "retmode": "json",
                    },
                    headers={"User-Agent": "basecase/0.1"},
                )
                search_response.raise_for_status()
                search_payload = search_response.json()
                identifiers = search_payload.get("esearchresult", {}).get("idlist", [])
                if not identifiers:
                    raise NCBIError(f"NCBI Gene has no human record for {normalized_symbol}")

                gene_id = str(identifiers[0])
                summary_response = await client.get(
                    f"{self.base_url}/esummary.fcgi",
                    params={"db": "gene", "id": gene_id, "retmode": "json"},
                    headers={"User-Agent": "basecase/0.1"},
                )
                summary_response.raise_for_status()
                summary_payload = summary_response.json()
        except NCBIError:
            raise
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise NCBIError(f"NCBI Gene request failed: {error}") from error

        raw = summary_payload.get("result", {}).get(gene_id)
        if not isinstance(raw, dict):
            raise NCBIError(f"NCBI Gene returned no summary for {normalized_symbol}")

        result = normalize_gene_summary(normalized_symbol, gene_id, raw)
        self._cache[normalized_symbol] = (monotonic() + 3600, result)
        return result


def normalize_gene_summary(
    requested_symbol: str,
    gene_id: str,
    raw: dict[str, Any],
) -> GeneSummaryResponse:
    genomic_info = raw.get("genomicinfo")
    first_genomic = (
        genomic_info[0]
        if isinstance(genomic_info, list) and genomic_info and isinstance(genomic_info[0], dict)
        else {}
    )
    aliases = [
        alias.strip() for alias in str(raw.get("otheraliases") or "").split(",") if alias.strip()
    ]
    mim = raw.get("mim")
    mim_ids = [str(identifier) for identifier in mim] if isinstance(mim, list) else []
    exon_count = first_genomic.get("exoncount")

    return GeneSummaryResponse(
        symbol=str(raw.get("nomenclaturesymbol") or raw.get("name") or requested_symbol),
        full_name=str(raw.get("nomenclaturename") or raw.get("description") or requested_symbol),
        summary=_optional_string(raw.get("summary")),
        aliases=aliases,
        chromosome=_optional_string(raw.get("chromosome")),
        map_location=_optional_string(raw.get("maplocation")),
        gene_id=gene_id,
        nomenclature_status=_optional_string(raw.get("nomenclaturestatus")),
        mim_ids=mim_ids,
        exon_count=int(exon_count) if isinstance(exon_count, int | float) else None,
        source_url=f"https://www.ncbi.nlm.nih.gov/gene/{gene_id}",
        retrieved_at=datetime.now(UTC),
    )


def _optional_string(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


ncbi_client = NCBIClient()
