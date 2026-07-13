import asyncio
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from html import unescape
from math import ceil
from time import monotonic
from typing import Any
from urllib.parse import quote_plus

import httpx

from app.models import (
    GeneSearchResponse,
    GeneSearchResult,
    GenomicFeature,
    TrackCatalogResponse,
    TrackDefinition,
    TrackFeaturesResponse,
    TrackKind,
    TrackSchemaResponse,
)

UCSC_API_URL = "https://api.genome.ucsc.edu"
POSITION_PATTERN = re.compile(r"^([^:]+):(\d+)-(\d+)$")

DEFAULT_TRACKS: dict[str, int] = {
    "cytoBandIdeo": 1,
    "altSeqLiftOverPsl": 2,
    "fixSeqLiftOverPsl": 3,
    "mane": 4,
    "knownGene": 5,
    "ncbiRefSeqCurated": 6,
    "omimAvSnp": 7,
    "omimGene2": 8,
    "gtexGeneV8": 9,
    "clinvarMain": 10,
    "dbSnp155Common": 11,
    "gnomadV4": 12,
    "cCREregistry": 13,
    "comments": 14,
    "multiz100way": 15,
    "phyloP100way": 16,
    "rmsk": 17,
}

COMPOSITE_TRACK_SOURCES: dict[str, tuple[str, ...]] = {
    "gnomadV4": ("gnomadExomesVariantsV4_1", "gnomadGenomesVariantsV4_1"),
    "sequenceContext": ("rmskJoinedCurrent", "genomicSuperDups", "encBlacklist"),
}

COMPOSITE_SOURCE_LABELS = {
    "gnomadExomesVariantsV4_1": "exomes",
    "gnomadGenomesVariantsV4_1": "genomes",
    "rmskJoinedCurrent": "repeat",
    "genomicSuperDups": "segmental_duplication",
    "encBlacklist": "blacklist",
}

SUPPORTED_TYPE_PREFIXES = (
    "bed",
    "bigbed",
    "bigdbsnp",
    "biggenepred",
    "genePred",
    "rmsk",
    "wig",
    "bigwig",
    "psl",
)

OMITTED_ATTRIBUTE_FIELDS = {
    "_jsonHgvsTable",
    "_mouseOver",
    "mouseOver",
    "reviewStatus",
}


class UCSCError(RuntimeError):
    pass


class UCSCClient:
    def __init__(
        self,
        base_url: str = UCSC_API_URL,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._cache: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=20.0,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
            headers={"User-Agent": "basecase/0.1"},
        )

    async def _request(self, endpoint: str, params: Mapping[str, str | int]) -> dict[str, Any]:
        query = ";".join(
            f"{quote_plus(key)}={quote_plus(str(value))}" for key, value in params.items()
        )
        url = f"{self.base_url}/{endpoint.lstrip('/')}?{query}"
        try:
            response = await self._client.get(url)
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise UCSCError(f"UCSC request failed: {error}") from error

        payload = response.json()
        if not isinstance(payload, dict):
            raise UCSCError("UCSC returned an unexpected response")
        if error_message := payload.get("error"):
            raise UCSCError(str(error_message))
        return payload

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _cached(self, key: str, ttl: int, loader: Any) -> Any:
        cached = self._cache.get(key)
        if cached and cached[0] > monotonic():
            return cached[1]

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(key)
            if cached and cached[0] > monotonic():
                return cached[1]
            value = await loader()
            self._cache[key] = (monotonic() + ttl, value)
            return value

    async def catalog(
        self,
        assembly: str,
        query: str | None = None,
        kind: TrackKind | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> TrackCatalogResponse:
        async def load_tracks() -> list[TrackDefinition]:
            payload = await self._request("list/tracks", {"genome": assembly, "trackLeavesOnly": 1})
            raw_tracks = payload.get(assembly)
            if not isinstance(raw_tracks, dict):
                raise UCSCError(f"Assembly {assembly!r} was not found at UCSC")
            normalized = composite_track_definitions(assembly)
            for track_id, raw in raw_tracks.items():
                if not isinstance(raw, dict):
                    continue
                track = normalize_track(assembly, str(track_id), raw)
                if is_supported(track.source_type):
                    normalized.append(track)
            return normalized

        all_tracks = await self._cached(f"normalized-catalog:{assembly}", 3600, load_tracks)
        needle = query.casefold().strip() if query else ""
        tokens = re.findall(r"[a-z0-9]+", needle)
        ranked: list[tuple[int, TrackDefinition]] = []
        for track in all_tracks:
            if kind and track.kind != kind:
                continue
            score = track_search_score(track, tokens, needle)
            if score is not None:
                ranked.append((score, track))

        ranked.sort(
            key=lambda item: (
                -item[0],
                item[1].default_rank is None,
                item[1].default_rank or 999,
                item[1].label.casefold(),
            )
        )
        tracks = [track for _, track in ranked]
        return TrackCatalogResponse(
            assembly=assembly,
            retrieved_at=datetime.now(UTC),
            total=len(tracks),
            offset=offset,
            limit=limit,
            tracks=tracks[offset : offset + limit],
        )

    async def schema(self, assembly: str, track_id: str) -> TrackSchemaResponse:
        if sources := COMPOSITE_TRACK_SOURCES.get(track_id):
            return TrackSchemaResponse(
                assembly=assembly,
                track_id=track_id,
                schema_data={"type": "composite", "source_tracks": list(sources)},
            )

        async def load() -> dict[str, Any]:
            return await self._request("list/schema", {"genome": assembly, "track": track_id})

        payload = await self._cached(f"schema:{assembly}:{track_id}", 3600, load)
        return TrackSchemaResponse(
            assembly=assembly,
            track_id=track_id,
            schema_data=payload,
        )

    async def search_genes(self, assembly: str, query: str) -> GeneSearchResponse:
        normalized_query = query.strip()

        async def load() -> dict[str, Any]:
            return await self._request("search", {"genome": assembly, "search": normalized_query})

        payload = await self._cached(
            f"gene-search:{assembly}:{normalized_query.casefold()}", 300, load
        )
        groups = payload.get("positionMatches", [])
        if not isinstance(groups, list):
            groups = []
        results = normalize_gene_search_results(assembly, normalized_query, groups)
        return GeneSearchResponse(query=normalized_query, assembly=assembly, results=results)

    async def resolve_position(self, assembly: str, query: str) -> tuple[str, int, int, str] | None:
        """Resolve a gene, rsID, or other UCSC search term to its best exact locus."""

        normalized_query = query.strip()
        payload = await self._request("search", {"genome": assembly, "search": normalized_query})
        groups = payload.get("positionMatches", [])
        if not isinstance(groups, list):
            return None
        query_folded = normalized_query.casefold()
        for group in groups:
            if not isinstance(group, Mapping):
                continue
            matches = group.get("matches", [])
            if not isinstance(matches, list):
                continue
            for match in matches:
                if not isinstance(match, Mapping):
                    continue
                searchable = " ".join(
                    str(match.get(field) or "")
                    for field in ("hgFindMatches", "posName", "description")
                ).casefold()
                if query_folded not in searchable:
                    continue
                highlight = re.search(
                    rf"{re.escape(assembly)}\.([^:]+):(\d+)-(\d+)",
                    str(match.get("highlight") or ""),
                )
                if highlight:
                    chrom, start_text, end_text = highlight.groups()
                    start = max(0, int(start_text) - 1)
                    return chrom, start, max(start + 1, int(end_text)), normalized_query
                position = POSITION_PATTERN.match(str(match.get("position") or ""))
                if position:
                    chrom, start_text, end_text = position.groups()
                    return chrom, int(start_text), int(end_text), normalized_query
        return None

    async def features(
        self,
        assembly: str,
        track_id: str,
        chrom: str,
        start: int,
        end: int,
        max_items: int,
    ) -> TrackFeaturesResponse:
        if sources := COMPOSITE_TRACK_SOURCES.get(track_id):
            per_source = max(1, ceil(max_items / len(sources)))
            responses = await asyncio.gather(
                *(
                    self.features(assembly, source_id, chrom, start, end, per_source)
                    for source_id in sources
                )
            )
            features = merge_composite_features(track_id, responses)
            truncated = (
                any(response.truncated for response in responses) or len(features) > max_items
            )
            features = features[:max_items]
            if track_id == "gnomadV4" and end - start > 12_000 and not truncated:
                features = downsample_population_density(features, start, end)
            return TrackFeaturesResponse(
                assembly=assembly,
                track_id=track_id,
                chrom=chrom,
                start=start,
                end=end,
                source_data_timestamp=next(
                    (
                        response.source_data_timestamp
                        for response in responses
                        if response.source_data_timestamp
                    ),
                    None,
                ),
                retrieved_at=datetime.now(UTC),
                truncated=truncated,
                features=features,
            )

        params: dict[str, str | int] = {
            "genome": assembly,
            "track": track_id,
            "chrom": chrom,
            "start": start,
            "end": end,
            "maxItemsOutput": max_items,
        }

        async def load() -> dict[str, Any]:
            return await self._request("getData/track", params)

        cache_key = f"features:{assembly}:{track_id}:{chrom}:{start}:{end}:{max_items}"
        payload = await self._cached(cache_key, 300, load)
        raw_features = payload.get(track_id, [])
        if not isinstance(raw_features, list):
            raw_features = []

        features = [
            normalize_feature(assembly, track_id, item, index)
            for index, item in enumerate(raw_features)
            if isinstance(item, dict)
        ]
        if features and all(feature.value is not None for feature in features):
            features = downsample_signal(features)
        return TrackFeaturesResponse(
            assembly=assembly,
            track_id=track_id,
            chrom=chrom,
            start=start,
            end=end,
            source_data_timestamp=_optional_string(payload.get("dataTimeStamp")),
            retrieved_at=datetime.now(UTC),
            truncated=len(features) >= max_items,
            features=features,
        )


def composite_track_definitions(assembly: str) -> list[TrackDefinition]:
    return [
        TrackDefinition(
            id="gnomadV4",
            assembly=assembly,
            label="gnomAD v4.1",
            description=(
                "Population allele frequencies from gnomAD v4.1 exomes and genomes, "
                "merged by allele."
            ),
            category="variation",
            kind="variant",
            source_type="composite",
            source_url="https://gnomad.broadinstitute.org/",
            data_version="v4.1",
            default_visible=True,
            default_rank=DEFAULT_TRACKS["gnomadV4"],
        ),
        TrackDefinition(
            id="sequenceContext",
            assembly=assembly,
            label="Sequence context",
            description=(
                "RepeatMasker elements, segmental duplications, and ENCODE blacklist regions."
            ),
            category="mapping",
            kind="repeat",
            source_type="composite",
            source_url=None,
            default_visible=False,
            default_rank=None,
        ),
    ]


def merge_composite_features(
    track_id: str, responses: list[TrackFeaturesResponse]
) -> list[GenomicFeature]:
    merged: list[GenomicFeature] = []
    by_allele: dict[tuple[str, int, int, str, str], int] = {}

    for response in responses:
        source_label = COMPOSITE_SOURCE_LABELS.get(response.track_id, response.track_id)
        for feature in response.features:
            source_url = feature.source_url
            attributes = {
                **feature.attributes,
                "composite_source": response.track_id,
                "dataset": source_label,
            }
            label = feature.label
            if track_id == "gnomadV4":
                ref = str(feature.attributes.get("ref", ""))
                alt = str(feature.attributes.get("alt", ""))
                key = (feature.chrom, feature.start, feature.end, ref, alt)
                allele_frequency = feature.attributes.get("AF")
                attributes[f"{source_label}_AF"] = allele_frequency
                attributes["datasets"] = [source_label]
                label = str(
                    feature.attributes.get("rsId")
                    or feature.attributes.get("_displayName")
                    or feature.label
                )
                display_name = str(feature.attributes.get("_displayName", ""))
                source_url = (
                    "https://gnomad.broadinstitute.org/variant/"
                    f"{display_name.removeprefix('chr')}?dataset=gnomad_r4"
                    if display_name
                    else feature.source_url
                )
                if key in by_allele:
                    index = by_allele[key]
                    existing = merged[index]
                    existing_datasets = existing.attributes.get("datasets", [])
                    datasets = (
                        list(existing_datasets)
                        if isinstance(existing_datasets, list)
                        else [str(existing_datasets)]
                    )
                    merged[index] = existing.model_copy(
                        update={
                            "attributes": {
                                **existing.attributes,
                                f"{source_label}_AF": allele_frequency,
                                "datasets": [*datasets, source_label],
                            }
                        }
                    )
                    continue
                by_allele[key] = len(merged)

            merged.append(
                feature.model_copy(
                    update={
                        "id": f"{response.track_id}:{feature.id}",
                        "track_id": track_id,
                        "label": label,
                        "source_url": source_url,
                        "attributes": attributes,
                    }
                )
            )

    return sorted(merged, key=lambda feature: (feature.start, feature.end, feature.id))


def downsample_population_density(
    features: list[GenomicFeature], start: int, end: int, bin_count: int = 160
) -> list[GenomicFeature]:
    if not features:
        return []
    span = max(1, end - start)
    bins: list[dict[str, Any]] = [
        {"count": 0, "max_af": 0.0, "feature": None} for _ in range(bin_count)
    ]
    for feature in features:
        index = max(0, min(bin_count - 1, int(((feature.start - start) / span) * bin_count)))
        bin_data = bins[index]
        bin_data["count"] = int(bin_data["count"]) + 1
        frequencies = [
            _optional_float(feature.attributes.get(field)) or 0.0
            for field in ("exomes_AF", "genomes_AF", "AF")
        ]
        bin_data["max_af"] = max(float(bin_data["max_af"]), *frequencies)
        if bin_data["feature"] is None:
            bin_data["feature"] = feature

    result: list[GenomicFeature] = []
    bin_width = span / bin_count
    for index, bin_data in enumerate(bins):
        count = int(bin_data["count"])
        representative = bin_data["feature"]
        if count == 0 or not isinstance(representative, GenomicFeature):
            continue
        bin_start = round(start + index * bin_width)
        bin_end = max(bin_start + 1, round(start + (index + 1) * bin_width))
        result.append(
            representative.model_copy(
                update={
                    "id": f"gnomadV4:density:{representative.chrom}:{bin_start}:{bin_end}",
                    "start": bin_start,
                    "end": bin_end,
                    "label": f"{count:,} population variants",
                    "value": float(count),
                    "source_url": None,
                    "attributes": {
                        "aggregation": "density",
                        "density_count": count,
                        "max_af": float(bin_data["max_af"]),
                    },
                }
            )
        )
    return result


def downsample_signal(
    features: list[GenomicFeature], target_points: int = 1200
) -> list[GenomicFeature]:
    if len(features) <= target_points:
        return features

    bin_size = ceil(len(features) / target_points)
    downsampled: list[GenomicFeature] = []
    for index in range(0, len(features), bin_size):
        group = features[index : index + bin_size]
        values = [feature.value for feature in group if feature.value is not None]
        if not values:
            continue
        first = group[0]
        start = min(feature.start for feature in group)
        end = max(feature.end for feature in group)
        downsampled.append(
            first.model_copy(
                update={
                    "id": f"{first.track_id}:{first.chrom}:{start}:{end}",
                    "start": start,
                    "end": end,
                    "label": f"Mean of {len(group)} bases",
                    "value": sum(values) / len(values),
                    "attributes": {
                        "aggregation": "mean",
                        "point_count": len(group),
                    },
                }
            )
        )
    return downsampled


def is_supported(source_type: str) -> bool:
    normalized = source_type.casefold()
    return any(normalized.startswith(prefix.casefold()) for prefix in SUPPORTED_TYPE_PREFIXES)


def track_search_score(track: TrackDefinition, tokens: list[str], needle: str) -> int | None:
    if not tokens:
        return 0
    track_id = track.id.casefold()
    label = track.label.casefold()
    description = track.description.casefold()
    metadata = f"{track.category} {track.kind} {track.source_type}".casefold()
    aliases = track_search_aliases(track)
    searchable = f"{track_id} {label} {description} {metadata} {aliases}"
    if any(token not in searchable for token in tokens):
        return None

    score = 0
    if needle in (track_id, label):
        score += 1000
    elif track_id.startswith(needle) or label.startswith(needle):
        score += 250
    for token in tokens:
        if token in label:
            score += 80
        if token in track_id:
            score += 60
        if token in metadata:
            score += 25
        if token in description:
            score += 10
        if token in aliases:
            score += 15
    if track.default_visible:
        score += 5
    return score


def track_search_aliases(track: TrackDefinition) -> str:
    aliases = {
        "gene": "gene genes transcript transcripts exon exons coding",
        "variant": "variant variants snp snps snv snvs indel indels allele alleles",
        "regulatory": "regulatory regulation enhancer enhancers promoter promoters chromatin",
        "signal": "signal coverage score scores peaks quantitative",
        "repeat": "repeat repeats repetitive sequence complexity mapping",
        "feature": "annotation annotations feature features",
    }[track.kind]
    track_id = track.id.casefold()
    if "clinvar" in track_id:
        aliases += " clinical pathogenic benign significance disease assertion assertions"
    if "gnomad" in track_id:
        aliases += " population frequency frequencies rare common constraint"
    if "ccre" in track_id:
        aliases += " encode cis element elements enhancer promoter ctcf"
    if "rmsk" in track_id or "repeatmasker" in track_id:
        aliases += " repeatmasker transposon alu line sine"
    if "mapp" in track_id or "blacklist" in track_id:
        aliases += " mappability mapping quality difficult region regions"
    return aliases


def normalize_gene_search_results(
    assembly: str, query: str, groups: list[Any]
) -> list[GeneSearchResult]:
    preferred_groups = ("hgnc", "mane", "knownGene", "refGene")
    groups_by_name = {str(group.get("name")): group for group in groups if isinstance(group, dict)}
    ordered_groups = [groups_by_name[name] for name in preferred_groups if name in groups_by_name]
    results: list[GeneSearchResult] = []
    seen: set[tuple[str, str, int, int]] = set()

    for group in ordered_groups:
        source_track = str(group.get("trackName", group.get("name", "gene")))
        matches = group.get("matches", [])
        if not isinstance(matches, list):
            continue
        for match in matches:
            if not isinstance(match, dict):
                continue
            position = POSITION_PATTERN.match(str(match.get("position", "")))
            if not position:
                continue
            symbol = _gene_symbol(str(match.get("posName", "")))
            if not symbol or query.casefold() not in symbol.casefold():
                continue
            chrom, start_text, end_text = position.groups()
            start, end = int(start_text), int(end_text)
            key = (symbol.casefold(), chrom, start, end)
            if key in seen:
                continue
            seen.add(key)
            results.append(
                GeneSearchResult(
                    id=str(match.get("hgFindMatches", symbol)),
                    symbol=symbol,
                    description=_optional_string(match.get("description")),
                    assembly=assembly,
                    chrom=chrom,
                    start=start,
                    end=end,
                    source_track=source_track,
                )
            )
            if len(results) >= 12:
                return results
        if results and str(group.get("name")) == "hgnc":
            return results[:12]
    return results[:12]


def _gene_symbol(value: str) -> str:
    text = unescape(value).strip()
    return re.split(r"[\s,(]", text, maxsplit=1)[0]


def normalize_track(assembly: str, track_id: str, raw: Mapping[str, Any]) -> TrackDefinition:
    source_type = str(raw.get("type", "unknown"))
    category = str(raw.get("group", raw.get("parent", "other"))).split()[0]
    rank = DEFAULT_TRACKS.get(track_id)
    return TrackDefinition(
        id=track_id,
        assembly=assembly,
        label=str(raw.get("shortLabel", track_id)),
        description=str(raw.get("longLabel", raw.get("shortLabel", track_id))),
        category=category,
        kind=infer_kind(track_id, source_type, category),
        source_type=source_type,
        source_url=_absolute_data_url(raw.get("bigDataUrl")),
        data_version=_optional_string(raw.get("dataVersion")),
        default_visible=rank is not None,
        default_rank=rank,
    )


def infer_kind(track_id: str, source_type: str, category: str) -> TrackKind:
    searchable = f"{track_id} {source_type} {category}".casefold()
    if "genepred" in searchable or track_id in {"mane", "knownGene", "gtexGeneV8"}:
        return "gene"
    if any(term in searchable for term in ("clinvar", "dbsnp", "gnomad", "gwas", "omimavsnp")):
        return "variant"
    if any(term in searchable for term in ("ccre", "encode", "regulation")):
        return "regulatory"
    if "wig" in searchable:
        return "signal"
    if "rmsk" in searchable or category == "rep":
        return "repeat"
    return "feature"


def normalize_feature(
    assembly: str, track_id: str, raw: Mapping[str, Any], index: int
) -> GenomicFeature:
    chrom = str(raw.get("chrom") or raw.get("genoName") or raw.get("tName") or "")
    start = int(
        raw.get(
            "chromStart",
            raw.get("start", raw.get("txStart", raw.get("genoStart", raw.get("tStart", 0)))),
        )
    )
    end = int(
        raw.get(
            "chromEnd",
            raw.get("end", raw.get("txEnd", raw.get("genoEnd", raw.get("tEnd", start + 1)))),
        )
    )
    name = str(raw.get("name") or raw.get("repName") or raw.get("qName") or "")
    label = _feature_label(raw) or f"{chrom}:{start + 1}-{end}"
    attributes = {
        key: value
        for key, value in raw.items()
        if key
        not in {
            "chrom",
            "chromStart",
            "chromEnd",
            "start",
            "end",
            "score",
            "value",
            "strand",
            "genoName",
            "genoStart",
            "genoEnd",
            "txStart",
            "txEnd",
            "tName",
            "tStart",
            "tEnd",
            *OMITTED_ATTRIBUTE_FIELDS,
        }
    }
    return GenomicFeature(
        id=name or f"{track_id}:{chrom}:{start}:{end}:{index}",
        track_id=track_id,
        assembly=assembly,
        chrom=chrom,
        start=start,
        end=max(end, start + 1),
        label=label,
        strand=_optional_string(raw.get("strand")),
        score=_optional_float(raw.get("score")),
        value=_optional_float(
            raw.get("value", raw.get("score") if track_id == "multiz100way" else None)
        ),
        source_url=_feature_source_url(track_id, raw),
        attributes=attributes,
    )


def _feature_label(raw: Mapping[str, Any]) -> str:
    for field in (
        "geneName2",
        "geneName",
        "name2",
        "origName",
        "repName",
        "qName",
        "name",
        "cCRE_class",
    ):
        if value := raw.get(field):
            return str(value).split(" : ")[-1]
    return ""


def _feature_source_url(track_id: str, raw: Mapping[str, Any]) -> str | None:
    if track_id.startswith("clinvar") and (vcv_id := raw.get("vcvId") or raw.get("name")):
        return f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{str(vcv_id).removeprefix('VCV').lstrip('0')}/"
    if track_id == "cCREregistry" and (name := raw.get("name")):
        return f"https://screen.wenglab.org/search?assembly=GRCh38&accessions={name}"
    if track_id in {"mane", "knownGene"} and (name := raw.get("name")):
        return f"https://www.ensembl.org/Homo_sapiens/Transcript/Summary?t={name}"
    return None


def _absolute_data_url(value: Any) -> str | None:
    if not value:
        return None
    url = str(value).strip('"')
    if url.startswith("/"):
        return f"https://genome.ucsc.edu{url}"
    return url


def _optional_string(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


ucsc_client = UCSCClient()
