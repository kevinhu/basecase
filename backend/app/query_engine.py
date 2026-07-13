import asyncio
import html
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from app.agent import EvidenceAgent, evidence_agent, extract_disease, region_gene_links
from app.models import (
    AgentAction,
    AgentAssumption,
    AgentChatRequest,
    AgentChatResponse,
    AgentEvidenceRelation,
    AgentEvidenceSource,
    AgentFeatureLink,
    AgentMetric,
    AgentRegion,
    AgentRegionLink,
    AgentSource,
    AgentVariant,
    GenomicFeature,
    QueryEntity,
    QueryFilters,
    QueryPlan,
    QueryRangeExpression,
    TrackFeaturesResponse,
    TrackKind,
)
from app.ucsc import UCSCError, ucsc_client

ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]
GENE_TOKEN = re.compile(r"\b[A-Z][A-Z0-9-]{1,15}\b")
RS_TOKEN = re.compile(r"\brs\d+\b", re.I)
VCF_ROW = re.compile(
    r"\b(chr)?([0-9XYM]+)\s+(\d+)\s+(?:\S+\s+)?([ACGTN]+)\s+([ACGTN,<>*]+)",
    re.I,
)
GENE_STOPWORDS = {
    "VCF",
    "HG19",
    "HG38",
    "GRCH37",
    "GRCH38",
    "MANE",
    "CLINVAR",
    "ENCODE",
    "UCSC",
    "DNA",
    "RNA",
}


@dataclass(frozen=True)
class EvidenceCapability:
    name: AgentEvidenceSource
    label: str
    tracks: tuple[str, ...]
    max_items: int
    source: AgentSource
    action_track: str | None = None
    supports_biosample: bool = False


CAPABILITY_REGISTRY: dict[AgentEvidenceSource, EvidenceCapability] = {
    "genes": EvidenceCapability(
        "genes",
        "gene annotations",
        ("mane", "ncbiRefSeqCurated"),
        1_000,
        AgentSource(label="UCSC Gene Annotations", url="https://genome.ucsc.edu/"),
        "mane",
    ),
    "transcripts": EvidenceCapability(
        "transcripts",
        "transcripts",
        ("mane", "ncbiRefSeqCurated"),
        1_000,
        AgentSource(label="MANE", url="https://www.ncbi.nlm.nih.gov/refseq/MANE/"),
        "mane",
    ),
    "clinvar": EvidenceCapability(
        "clinvar",
        "ClinVar",
        ("clinvarMain",),
        2_000,
        AgentSource(label="ClinVar", url="https://www.ncbi.nlm.nih.gov/clinvar/"),
        "clinvarMain",
    ),
    "regulatory": EvidenceCapability(
        "regulatory",
        "ENCODE cCREs",
        ("cCREregistry",),
        1_000,
        AgentSource(label="ENCODE cCRE Registry", url="https://screen.wenglab.org/"),
        "cCREregistry",
    ),
    "conservation": EvidenceCapability(
        "conservation",
        "phyloP conservation",
        ("phyloP100way",),
        2_000,
        AgentSource(label="UCSC phyloP 100-way", url="https://genome.ucsc.edu/"),
        "phyloP100way",
    ),
    "sequence": EvidenceCapability(
        "sequence",
        "sequence context",
        ("sequenceContext",),
        1_000,
        AgentSource(label="UCSC Sequence Context", url="https://genome.ucsc.edu/"),
    ),
}


class QueryEngineError(RuntimeError):
    pass


def heuristic_plan(request: AgentChatRequest) -> QueryPlan:
    """Capability-oriented fallback used if model planning is unavailable."""

    text = request.message
    folded = text.casefold()
    disease = extract_disease(text)
    if disease:
        return QueryPlan(
            intent="disease_genes",
            assembly=request.assembly,
            entities=[QueryEntity(type="disease", value=disease)],
            range=QueryRangeExpression(type="context"),
            evidence=["genes"],
            filters=QueryFilters(),
            output="summary",
        )

    entities: list[QueryEntity] = []
    if rs_match := RS_TOKEN.search(text):
        entities.append(QueryEntity(type="variant", value=rs_match.group(0).lower()))
    elif vcf_match := VCF_ROW.search(text):
        entities.append(QueryEntity(type="vcf", value=vcf_match.group(0)))
    else:
        gene = next(
            (
                token
                for token in GENE_TOKEN.findall(text)
                if token.upper() not in GENE_STOPWORDS and not token.isdigit()
            ),
            None,
        )
        if gene:
            entities.append(QueryEntity(type="gene", value=gene))
        elif request.feature:
            entity_type = "variant" if request.feature.kind == "variant" else "context"
            entities.append(QueryEntity(type=entity_type, value=request.feature.label))
        else:
            entities.append(QueryEntity(type="context", value="attached browser context"))

    if "promoter" in folded:
        range_expression = QueryRangeExpression(type="promoter")
    elif any(word in folded for word in ("nearby", "around", "near ")):
        radius_match = re.search(r"(\d+(?:\.\d+)?)\s*(kb|mb|bp)", folded)
        radius = 50_000
        if radius_match:
            amount = float(radius_match.group(1))
            multiplier = {"bp": 1, "kb": 1_000, "mb": 1_000_000}[radius_match.group(2)]
            radius = min(2_500_000, max(1, round(amount * multiplier)))
        range_expression = QueryRangeExpression(type="around", radius_bp=radius)
    elif entities[0].type == "gene":
        range_expression = QueryRangeExpression(type="gene")
    else:
        range_expression = QueryRangeExpression(type="context")

    evidence: list[AgentEvidenceSource] = []
    if any(word in folded for word in ("clinvar", "pathogenic", "variant", "vcf")):
        evidence.append("clinvar")
    if any(word in folded for word in ("enhancer", "regulatory", "regulation", "ccre")):
        evidence.append("regulatory")
    if any(word in folded for word in ("conservation", "conserved", "phylop")):
        evidence.append("conservation")
    if any(word in folded for word in ("transcript", "exon", "utr")):
        evidence.append("transcripts")
    if not evidence:
        evidence = ["genes", "clinvar", "regulatory", "conservation", "sequence"]

    significance = ["Pathogenic", "Likely pathogenic"] if "pathogenic" in folded else []
    biosample = None
    if "blood" in folded:
        biosample = "blood cells"
    regulatory_classes = ["enhancer"] if "enhancer" in folded else []
    output = (
        "variant_table"
        if "clinvar" in evidence and any(word in folded for word in ("variant", "pathogenic"))
        else "evidence_matrix"
        if len(evidence) > 1
        else "feature_table"
    )
    return QueryPlan(
        intent="genomic_evidence",
        assembly=request.assembly,
        entities=entities,
        range=range_expression,
        evidence=evidence,
        filters=QueryFilters(
            clinical_significance=significance,
            biosample=biosample,
            regulatory_classes=regulatory_classes,
        ),
        output=output,
    )


def reconcile_plan(request: AgentChatRequest, planned: QueryPlan) -> QueryPlan:
    """Prefer explicit user language over ambient browser context in a model plan."""

    explicit = heuristic_plan(request)
    explicit_entity = explicit.entities[0] if explicit.entities else None
    planned_entity = planned.entities[0] if planned.entities else None
    if explicit_entity and explicit_entity.type in {"gene", "variant", "vcf", "disease"}:
        entities = explicit.entities
        range_expression = explicit.range
    else:
        entities = planned.entities or explicit.entities
        range_expression = planned.range
    evidence = list(dict.fromkeys([*planned.evidence, *explicit.evidence]))
    filters = planned.filters.model_copy(
        update={
            "clinical_significance": list(
                dict.fromkeys(
                    [
                        *planned.filters.clinical_significance,
                        *explicit.filters.clinical_significance,
                    ]
                )
            ),
            "biosample": explicit.filters.biosample or planned.filters.biosample,
            "regulatory_classes": list(
                dict.fromkeys(
                    [
                        *planned.filters.regulatory_classes,
                        *explicit.filters.regulatory_classes,
                    ]
                )
            ),
        }
    )
    intent = explicit.intent if explicit.intent == "disease_genes" else planned.intent
    if planned_entity and planned_entity.type == "disease":
        intent = "disease_genes"
    return planned.model_copy(
        update={
            "intent": intent,
            "assembly": request.assembly,
            "entities": entities,
            "range": range_expression,
            "evidence": evidence,
            "filters": filters,
            "output": explicit.output if explicit_entity else planned.output,
        }
    )


class GenomicQueryEngine:
    def __init__(self, fallback_agent: EvidenceAgent) -> None:
        self._fallback_agent = fallback_agent

    async def execute(
        self,
        request: AgentChatRequest,
        plan: QueryPlan,
        on_event: ProgressCallback | None = None,
    ) -> AgentChatResponse:
        if plan.intent == "disease_genes":
            disease = next((item.value for item in plan.entities if item.type == "disease"), None)
            if disease:
                return await self._fallback_agent.disease_genes(disease, plan.assembly)
        if plan.intent == "help":
            return await self._fallback_agent.chat(request)

        if on_event:
            await on_event(
                {
                    "type": "progress",
                    "stage": "grounding",
                    "message": "Resolving entities and genomic ranges",
                }
            )
        ranges, assumptions, anchor = await self._resolve_ranges(request, plan)
        if not ranges:
            raise QueryEngineError("I could not resolve the requested entity to a genomic range")

        if on_event:
            labels = ", ".join(source_label(source) for source in plan.evidence)
            await on_event(
                {
                    "type": "progress",
                    "stage": "grounding",
                    "message": f"Querying {labels}",
                }
            )
        results = await self._fetch_evidence(plan, ranges)
        response = self._assemble_response(plan, ranges, assumptions, anchor, results)
        if on_event:
            count = len(response.variants) + len(response.features) + len(response.genes)
            await on_event(
                {
                    "type": "progress",
                    "stage": "grounding",
                    "message": f"Validated {count} typed evidence records with provenance",
                }
            )
            if not response.result_complete:
                await on_event(
                    {
                        "type": "progress",
                        "stage": "grounding",
                        "message": "Flagging source limitations and incomplete result sets",
                    }
                )
        return response

    async def _resolve_ranges(
        self, request: AgentChatRequest, plan: QueryPlan
    ) -> tuple[list[AgentRegionLink], list[AgentAssumption], int | None]:
        assumptions: list[AgentAssumption] = []
        entity = plan.entities[0] if plan.entities else QueryEntity(type="context", value="context")
        if plan.range.type == "context":
            attached = request.regions or ([request.region] if request.region else [])
            if request.feature and not attached:
                attached = [
                    AgentRegion(
                        assembly=request.assembly,
                        chrom=request.feature.chrom,
                        start=request.feature.start,
                        end=request.feature.end,
                    )
                ]
            if not attached and entity.type == "vcf":
                parsed = parse_vcf_region(entity.value, plan.assembly)
                attached = [parsed] if parsed else []
            regions = [
                region_link(
                    region, f"Selected region {index}" if len(attached) > 1 else "Selected region"
                )
                for index, region in enumerate(attached, start=1)
            ]
            anchor = midpoint(regions[0]) if regions else None
            return regions, assumptions, anchor

        if entity.type == "variant":
            resolved = await ucsc_client.resolve_position(plan.assembly, entity.value)
            if not resolved:
                raise QueryEngineError(f"No {plan.assembly} position was found for {entity.value}")
            chrom, start, end, label = resolved
            anchor = start
            radius = plan.range.radius_bp if plan.range.type == "around" else 250
            assumptions.append(AgentAssumption(label="Nearby radius", value=format_span(radius)))
            return (
                [
                    AgentRegionLink(
                        id=f"{plan.assembly}:{chrom}:{max(0, start - radius)}-{end + radius}",
                        label=f"{label} ± {format_span(radius)}",
                        assembly=plan.assembly,
                        chrom=chrom,
                        start=max(0, start - radius),
                        end=end + radius,
                        description=f"Range centered on {label}",
                    )
                ],
                assumptions,
                anchor,
            )

        if entity.type == "vcf":
            variant = parse_vcf_region(entity.value, plan.assembly)
            if not variant:
                raise QueryEngineError(
                    "The VCF row could not be parsed into CHROM, POS, REF, and ALT"
                )
            radius = plan.range.radius_bp if plan.range.type == "around" else 5_000
            assumptions.append(AgentAssumption(label="Context radius", value=format_span(radius)))
            return (
                [
                    AgentRegionLink(
                        id=f"vcf:{variant.chrom}:{variant.start}:{variant.end}",
                        label="VCF allele context",
                        assembly=variant.assembly,
                        chrom=variant.chrom,
                        start=max(0, variant.start - radius),
                        end=variant.end + radius,
                        description=entity.value,
                    )
                ],
                assumptions,
                variant.start,
            )

        gene_symbol = entity.value
        search = await ucsc_client.search_genes(plan.assembly, gene_symbol)
        exact = next(
            (
                result
                for result in search.results
                if result.symbol.casefold() == gene_symbol.casefold()
            ),
            search.results[0] if search.results else None,
        )
        if not exact:
            raise QueryEngineError(f"No {plan.assembly} locus was found for {gene_symbol}")
        gene_region = AgentRegion(
            assembly=plan.assembly,
            chrom=exact.chrom,
            start=exact.start,
            end=exact.end,
        )
        if plan.range.type == "gene":
            return (
                [region_link(gene_region, gene_symbol, "Resolved gene locus")],
                assumptions,
                midpoint(gene_region),
            )

        transcripts = await ucsc_client.features(
            plan.assembly, "mane", exact.chrom, exact.start, exact.end, 100
        )
        transcript = next(
            (
                feature
                for feature in transcripts.features
                if feature.label.casefold() == gene_symbol.casefold()
            ),
            transcripts.features[0] if transcripts.features else None,
        )
        if not transcript:
            raise QueryEngineError(f"No MANE transcript was found for {gene_symbol}")
        tss = transcript.start if transcript.strand != "-" else transcript.end
        if transcript.strand == "-":
            start = max(0, tss - plan.range.downstream_bp)
            end = tss + plan.range.upstream_bp
        else:
            start = max(0, tss - plan.range.upstream_bp)
            end = tss + plan.range.downstream_bp
        assumptions.extend(
            [
                AgentAssumption(label="Transcript", value=f"MANE Select · {transcript.id}"),
                AgentAssumption(
                    label="Promoter definition",
                    value=(
                        f"{format_span(plan.range.upstream_bp)} upstream / "
                        f"{format_span(plan.range.downstream_bp)} downstream of the TSS"
                    ),
                ),
            ]
        )
        return (
            [
                AgentRegionLink(
                    id=f"promoter:{transcript.id}",
                    label=f"{gene_symbol} promoter",
                    assembly=plan.assembly,
                    chrom=transcript.chrom,
                    start=start,
                    end=end,
                    description=(
                        "Strand-aware promoter around the "
                        f"{plan.range.transcript_policy.upper()} TSS"
                    ),
                )
            ],
            assumptions,
            tss,
        )

    async def _fetch_evidence(
        self, plan: QueryPlan, ranges: list[AgentRegionLink]
    ) -> dict[str, list[TrackFeaturesResponse]]:
        jobs: list[tuple[str, Awaitable[TrackFeaturesResponse]]] = []
        for source in plan.evidence:
            capability = CAPABILITY_REGISTRY[source]
            for track_id in capability.tracks:
                for region in ranges:
                    jobs.append(
                        (
                            source,
                            ucsc_client.features(
                                region.assembly,
                                track_id,
                                region.chrom,
                                region.start,
                                region.end,
                                capability.max_items,
                            ),
                        )
                    )
        values = await asyncio.gather(*(job for _, job in jobs), return_exceptions=True)
        results: dict[str, list[TrackFeaturesResponse]] = {}
        for (source, _), value in zip(jobs, values, strict=True):
            if isinstance(value, TrackFeaturesResponse):
                results.setdefault(source, []).append(value)
            elif isinstance(value, UCSCError):
                continue
        return results

    def _assemble_response(
        self,
        plan: QueryPlan,
        ranges: list[AgentRegionLink],
        assumptions: list[AgentAssumption],
        anchor: int | None,
        results: dict[str, list[TrackFeaturesResponse]],
    ) -> AgentChatResponse:
        variants = [
            normalize_variant(feature, anchor)
            for response in results.get("clinvar", [])
            for feature in response.features
            if matches_significance(feature, plan.filters.clinical_significance)
        ]
        variants.sort(key=lambda item: (item.distance is None, item.distance or 0, item.start))
        regulatory = [
            normalize_feature_link(feature, "regulatory", anchor)
            for response in results.get("regulatory", [])
            for feature in response.features
            if matches_regulatory_class(feature, plan.filters.regulatory_classes)
        ]
        regulatory.sort(
            key=lambda item: (item.distance is None, item.distance or 0, -(item.score or 0))
        )
        transcript_features = [
            normalize_feature_link(feature, "gene", anchor)
            for response in results.get("transcripts", []) + results.get("genes", [])
            for feature in response.features
        ]
        conservation_features: list[AgentFeatureLink] = []
        conservation_values = [
            feature.value
            for response in results.get("conservation", [])
            for feature in response.features
            if feature.value is not None
        ]
        if conservation_values:
            peak = max(conservation_values)
            mean = sum(conservation_values) / len(conservation_values)
            region = ranges[0]
            conservation_features.append(
                AgentFeatureLink(
                    id=f"phyloP:{region.chrom}:{region.start}-{region.end}",
                    label="phyloP 100-way conservation",
                    kind="signal",
                    assembly=region.assembly,
                    chrom=region.chrom,
                    start=region.start,
                    end=region.end,
                    category="conservation",
                    context=f"Mean {mean:.2f} · peak {peak:.2f}",
                    value=peak,
                    source_url="https://genome.ucsc.edu/",
                )
            )
        features = [*regulatory[:100], *transcript_features[:50], *conservation_features]

        genes = []
        gene_responses = results.get("genes", []) + results.get("transcripts", [])
        for response in gene_responses:
            genes.extend(
                region_gene_links({response.track_id: response.features}, response.assembly)
            )
        genes = list({gene.symbol.casefold(): gene for gene in genes}.values())[:12]

        truncated_sources = sorted(
            {
                source_label(source)
                for source, responses in results.items()
                if any(response.truncated for response in responses)
            }
        )
        complete = not truncated_sources
        if plan.filters.biosample and "regulatory" in plan.evidence:
            assumptions.append(
                AgentAssumption(
                    label="Biosample limitation",
                    value=(
                        "The available cCRE registry reports cross-biosample maximum activity; "
                        f"it does not prove activity specifically in {plan.filters.biosample}."
                    ),
                )
            )
            complete = False

        metrics = [
            AgentMetric(label="Query range", value=format_region(ranges[0])),
        ]
        if "clinvar" in plan.evidence:
            total = sum(len(response.features) for response in results.get("clinvar", []))
            suffix = (
                "+" if any(response.truncated for response in results.get("clinvar", [])) else ""
            )
            metrics.append(
                AgentMetric(
                    label="ClinVar matches",
                    value=f"{len(variants)} matching · {total}{suffix} examined",
                    tone="warning" if variants else "neutral",
                )
            )
        if regulatory:
            metrics.append(AgentMetric(label="Regulatory elements", value=str(len(regulatory))))
        if conservation_values:
            metrics.append(
                AgentMetric(
                    label="Conservation", value=f"peak phyloP {max(conservation_values):.2f}"
                )
            )

        subject = plan.entities[0].value if plan.entities else ranges[0].label
        parts = []
        if "clinvar" in plan.evidence:
            parts.append(f"{len(variants)} matching ClinVar variants")
        if "regulatory" in plan.evidence:
            parts.append(f"{len(regulatory)} regulatory elements")
        if "transcripts" in plan.evidence:
            parts.append(f"{len(transcript_features)} transcript records")
        if "conservation" in plan.evidence and conservation_values:
            parts.append(f"a peak phyloP score of {max(conservation_values):.2f}")
        summary = (
            f"Across {ranges[0].label}, the grounded query found {human_join(parts)}."
            if parts
            else f"No matching records were returned for {subject} with the requested filters."
        )
        sources = source_records(plan.evidence)
        relations = [
            AgentEvidenceRelation(
                subject_id=item.id,
                predicate="overlaps" if item.distance in {None, 0} else "nearby",
                object_id=ranges[0].id,
                source="ClinVar",
            )
            for item in variants
        ] + [
            AgentEvidenceRelation(
                subject_id=item.id,
                predicate="overlaps" if item.distance in {None, 0} else "nearby",
                object_id=ranges[0].id,
                source=item.category or item.kind,
            )
            for item in features
        ]
        caveats = []
        if truncated_sources:
            caveats.append(
                f"Incomplete source results: {', '.join(truncated_sources)} reached their limits."
            )
        if plan.filters.biosample:
            caveats.append(
                "Cell-type-specific activity requires a biosample-resolved ENCODE connector."
            )
        return AgentChatResponse(
            kind="genomic_query",
            title=f"Evidence for {display_subject(subject)} in {plan.assembly}",
            summary=summary,
            genes=genes,
            metrics=metrics,
            sources=sources,
            variants=variants[:100],
            features=features,
            regions=ranges,
            assumptions=assumptions,
            actions=[
                AgentAction(
                    type="focus",
                    label=f"Open {region.label}",
                    region=AgentRegion(
                        assembly=region.assembly,
                        chrom=region.chrom,
                        start=region.start,
                        end=region.end,
                    ),
                    highlight_region=(
                        AgentRegion(
                            assembly=region.assembly,
                            chrom=region.chrom,
                            start=anchor,
                            end=anchor + 1,
                        )
                        if anchor is not None and plan.entities
                        and plan.entities[0].type in {"variant", "vcf"}
                        else AgentRegion(
                            assembly=region.assembly,
                            chrom=region.chrom,
                            start=region.start,
                            end=region.end,
                        )
                    ),
                )
                for region in ranges
            ]
            + [
                AgentAction(
                    type="add_track",
                    label=f"Show {CAPABILITY_REGISTRY[source].label}",
                    track_id=CAPABILITY_REGISTRY[source].action_track,
                )
                for source in plan.evidence
                if CAPABILITY_REGISTRY[source].action_track
            ],
            relations=relations,
            result_complete=complete,
            caveat=" ".join(caveats) or None,
        )


def parse_vcf_region(value: str, assembly: str) -> AgentRegion | None:
    match = VCF_ROW.search(value)
    if not match:
        return None
    chrom = f"chr{match.group(2)}"
    position = int(match.group(3))
    ref = match.group(4)
    start = max(0, position - 1)
    return AgentRegion(assembly=assembly, chrom=chrom, start=start, end=start + len(ref))


def display_subject(subject: str) -> str:
    cleaned = subject.replace("_", " ").strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else "selected evidence"


def region_link(region: AgentRegion, label: str, description: str | None = None) -> AgentRegionLink:
    return AgentRegionLink(
        id=f"{region.assembly}:{region.chrom}:{region.start}-{region.end}",
        label=label,
        assembly=region.assembly,
        chrom=region.chrom,
        start=region.start,
        end=region.end,
        description=description,
    )


def midpoint(region: AgentRegion | AgentRegionLink) -> int:
    return region.start + max(1, region.end - region.start) // 2


def matches_significance(feature: GenomicFeature, requested: list[str]) -> bool:
    if not requested:
        return True
    significance = str(feature.attributes.get("clinSign") or "").casefold()
    return (
        any(value.casefold() in significance for value in requested)
        and "conflict" not in significance
    )


def matches_regulatory_class(feature: GenomicFeature, requested: list[str]) -> bool:
    if not requested:
        return True
    category = str(feature.attributes.get("cCRE_class") or "").casefold()
    for value in requested:
        folded = value.casefold()
        if folded == "enhancer" and "els" in category:
            return True
        if folded == "promoter" and "pls" in category:
            return True
        if folded in category:
            return True
    return False


def normalize_variant(feature: GenomicFeature, anchor: int | None) -> AgentVariant:
    attributes = feature.attributes
    orig_name = str(attributes.get("origName") or "")
    hgvs = orig_name.split(" : ", 1)[1] if " : " in orig_name else None
    review = re.sub(r"<[^>]+>", "", html.unescape(str(attributes.get("reviewStatus") or "")))
    phenotype = re.sub(r"<[^>]+>", "", html.unescape(str(attributes.get("phenotypeList") or "")))
    label = str(attributes.get("snpId") or feature.label or feature.id)
    return AgentVariant(
        id=feature.id,
        label=label,
        assembly=feature.assembly,
        chrom=feature.chrom,
        start=feature.start,
        end=feature.end,
        hgvs=hgvs,
        significance=str(attributes.get("clinSign") or "") or None,
        review_status=review.strip() or None,
        consequence=str(attributes.get("molConseq") or "") or None,
        conditions=[phenotype] if phenotype else [],
        distance=distance_to(feature.start, feature.end, anchor),
        source_url=feature.source_url,
    )


def normalize_feature_link(
    feature: GenomicFeature,
    kind: TrackKind,
    anchor: int | None,
    context: str | None = None,
) -> AgentFeatureLink:
    category = str(
        feature.attributes.get("cCRE_class")
        or feature.attributes.get("maneStat")
        or feature.attributes.get("geneType")
        or ""
    )
    score_values = [
        value
        for key in ("DNase_maxZ", "H3K4me3_maxZ", "H3K27ac_maxZ", "CTCF_maxZ")
        if (value := number(feature.attributes.get(key))) is not None
    ]
    return AgentFeatureLink(
        id=feature.id,
        label=feature.label,
        kind=kind,
        assembly=feature.assembly,
        chrom=feature.chrom,
        start=feature.start,
        end=feature.end,
        category=category or None,
        context=context,
        score=max(score_values) if score_values else feature.score,
        value=feature.value,
        distance=distance_to(feature.start, feature.end, anchor),
        source_url=feature.source_url,
    )


def distance_to(start: int, end: int, anchor: int | None) -> int | None:
    if anchor is None:
        return None
    if start <= anchor <= end:
        return 0
    return min(abs(start - anchor), abs(end - anchor))


def number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def source_label(source: str) -> str:
    capability = next((item for name, item in CAPABILITY_REGISTRY.items() if name == source), None)
    return capability.label if capability else source


def source_records(sources: Sequence[str]) -> list[AgentSource]:
    records = []
    seen_urls: set[str] = set()
    for source in dict.fromkeys(sources):
        capability = next(
            (item for name, item in CAPABILITY_REGISTRY.items() if name == source), None
        )
        if capability and capability.source.url not in seen_urls:
            records.append(capability.source)
            seen_urls.add(capability.source.url)
    return records


def format_span(span: int) -> str:
    if span >= 1_000_000:
        return f"{span / 1_000_000:g} Mb"
    if span >= 1_000:
        return f"{span / 1_000:g} kb"
    return f"{span} bp"


def format_region(region: AgentRegionLink) -> str:
    return f"{region.chrom}:{region.start + 1:,}-{region.end:,}"


def human_join(items: list[str]) -> str:
    if not items:
        return "no evidence"
    if len(items) == 1:
        return items[0]
    return f"{', '.join(items[:-1])}, and {items[-1]}"


genomic_query_engine = GenomicQueryEngine(fallback_agent=evidence_agent)
