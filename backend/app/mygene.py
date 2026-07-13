import asyncio
import re
from collections.abc import Mapping
from time import monotonic
from typing import Any

import httpx

from app.models import GeneSearchResponse, GeneSearchResult

MYGENE_QUERY_URL = "https://mygene.info/v3/query"
ASSEMBLY_POSITION_FIELDS = {
    "hg38": "genomic_pos",
    "hg19": "genomic_pos_hg19",
}
QUERY_TOKEN_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")


class MyGeneError(RuntimeError):
    pass


class MyGeneClient:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=5.0,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            headers={"User-Agent": "basecase/0.1"},
        )
        self._cache: dict[str, tuple[float, GeneSearchResponse]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def search_genes(self, assembly: str, query: str) -> GeneSearchResponse:
        position_field = ASSEMBLY_POSITION_FIELDS.get(assembly)
        normalized_query = query.strip()
        token = QUERY_TOKEN_PATTERN.sub("", normalized_query)
        if not position_field or len(token) < 2:
            return GeneSearchResponse(
                query=normalized_query,
                assembly=assembly,
                source="mygene",
                results=[],
            )

        cache_key = f"{assembly}:{token.casefold()}"
        cached = self._cache.get(cache_key)
        if cached and cached[0] > monotonic():
            return cached[1]

        lock = self._locks.setdefault(cache_key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(cache_key)
            if cached and cached[0] > monotonic():
                return cached[1]
            result = await self._load(assembly, token, position_field)
            self._cache[cache_key] = (monotonic() + 3600, result)
            return result

    async def _load(
        self,
        assembly: str,
        token: str,
        position_field: str,
    ) -> GeneSearchResponse:
        params = {
            "q": (
                f"symbol:{token} OR alias:{token} OR "
                f"symbol:{token}* OR alias:{token}*"
            ),
            "species": "human",
            "fields": (
                f"symbol,name,alias,{position_field},entrezgene,ensembl.gene"
            ),
            "size": 24,
        }
        try:
            response = await self._client.get(MYGENE_QUERY_URL, params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise MyGeneError(f"MyGene request failed: {error}") from error
        if not isinstance(payload, dict):
            raise MyGeneError("MyGene returned an unexpected response")
        hits = payload.get("hits", [])
        if not isinstance(hits, list):
            hits = []
        results = normalize_mygene_results(assembly, token, position_field, hits)
        return GeneSearchResponse(
            query=token,
            assembly=assembly,
            source="mygene",
            results=results[:8],
        )

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def normalize_mygene_results(
    assembly: str,
    query: str,
    position_field: str,
    hits: list[Any],
) -> list[GeneSearchResult]:
    normalized_query = query.casefold()
    ranked: list[tuple[int, float, GeneSearchResult]] = []
    seen: set[tuple[str, str, int, int]] = set()
    for raw in hits:
        if not isinstance(raw, Mapping):
            continue
        symbol = _text(raw.get("symbol"))
        position = _primary_position(raw.get(position_field))
        if not symbol or not position:
            continue
        chrom_value = _text(position.get("chr"))
        start = _integer(position.get("start"))
        inclusive_end = _integer(position.get("end"))
        if not chrom_value or start is None or inclusive_end is None or inclusive_end < start:
            continue
        chrom = chrom_value if chrom_value.startswith("chr") else f"chr{chrom_value}"
        end = inclusive_end + 1
        key = (symbol.casefold(), chrom, start, end)
        if key in seen:
            continue
        seen.add(key)
        aliases = _strings(raw.get("alias"))
        symbol_folded = symbol.casefold()
        alias_folded = [alias.casefold() for alias in aliases]
        if symbol_folded == normalized_query:
            rank = 0
        elif symbol_folded.startswith(normalized_query):
            rank = 1
        elif normalized_query in alias_folded:
            rank = 2
        elif any(alias.startswith(normalized_query) for alias in alias_folded):
            rank = 3
        else:
            rank = 4
        result = GeneSearchResult(
            id=_text(raw.get("entrezgene")) or _text(raw.get("_id")) or symbol,
            symbol=symbol,
            description=_text(raw.get("name")),
            assembly=assembly,
            chrom=chrom,
            start=start,
            end=end,
            source_track="MyGene.info",
        )
        score = _number(raw.get("_score")) or 0.0
        ranked.append((rank, -score, result))
    ranked.sort(key=lambda item: (item[0], item[1], item[2].symbol.casefold()))
    return [result for _, _, result in ranked]


def _primary_position(value: Any) -> Mapping[str, Any] | None:
    positions = value if isinstance(value, list) else [value]
    candidates = [position for position in positions if isinstance(position, Mapping)]
    if not candidates:
        return None
    canonical = [
        position
        for position in candidates
        if (_text(position.get("chr")) or "").removeprefix("chr")
        in {*map(str, range(1, 23)), "X", "Y", "MT", "M"}
    ]
    return (canonical or candidates)[0]


def _text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _strings(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    return [text for item in values if (text := _text(item))]


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


mygene_client = MyGeneClient()
