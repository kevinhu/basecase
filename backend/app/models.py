from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

TrackKind = Literal["gene", "variant", "regulatory", "signal", "repeat", "feature"]
AgentEvidenceSource = Literal[
    "genes", "transcripts", "clinvar", "regulatory", "conservation", "sequence"
]


class TrackDefinition(BaseModel):
    id: str
    assembly: str
    label: str
    description: str
    category: str
    kind: TrackKind
    source_type: str
    source_url: str | None = None
    data_version: str | None = None
    default_visible: bool = False
    default_rank: int | None = None


class TrackCatalogResponse(BaseModel):
    assembly: str
    source: Literal["ucsc"] = "ucsc"
    retrieved_at: datetime
    total: int
    offset: int
    limit: int
    tracks: list[TrackDefinition]


class TrackSchemaResponse(BaseModel):
    assembly: str
    track_id: str
    source: Literal["ucsc"] = "ucsc"
    schema_data: dict[str, Any]


class GenomicFeature(BaseModel):
    id: str
    track_id: str
    assembly: str
    chrom: str
    start: int
    end: int
    label: str
    strand: str | None = None
    score: float | None = None
    value: float | None = None
    source_url: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class TrackFeaturesResponse(BaseModel):
    assembly: str
    track_id: str
    chrom: str
    start: int
    end: int
    source: Literal["ucsc"] = "ucsc"
    source_data_timestamp: str | None = None
    retrieved_at: datetime
    truncated: bool
    features: list[GenomicFeature]


class GeneSearchResult(BaseModel):
    id: str
    symbol: str
    description: str | None = None
    assembly: str
    chrom: str
    start: int
    end: int
    source_track: str


class GeneSearchResponse(BaseModel):
    query: str
    assembly: str
    source: Literal["ucsc", "mygene"] = "ucsc"
    results: list[GeneSearchResult]


class GeneSummaryResponse(BaseModel):
    symbol: str
    full_name: str
    summary: str | None = None
    aliases: list[str] = Field(default_factory=list)
    chromosome: str | None = None
    map_location: str | None = None
    gene_id: str
    nomenclature_status: str | None = None
    mim_ids: list[str] = Field(default_factory=list)
    exon_count: int | None = None
    source: Literal["ncbi_gene"] = "ncbi_gene"
    source_url: str
    retrieved_at: datetime


class LiteratureArticle(BaseModel):
    pmid: str
    title: str
    journal: str | None = None
    year: int | None = None
    authors: list[str] = Field(default_factory=list)
    doi: str | None = None
    pmcid: str | None = None
    relevance_score: float | None = None
    source_url: str


class GeneLiteratureResponse(BaseModel):
    symbol: str
    source: Literal["pubtator3"] = "pubtator3"
    total: int
    articles: list[LiteratureArticle]
    retrieved_at: datetime


class TissueExpression(BaseModel):
    tissue_id: str
    tissue_name: str
    ontology_id: str | None = None
    median: float
    unit: str


class GeneExpressionResponse(BaseModel):
    symbol: str
    source: Literal["gtex"] = "gtex"
    dataset_id: str
    gencode_id: str
    tissues: list[TissueExpression]
    retrieved_at: datetime


class AgentRegion(BaseModel):
    assembly: str
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class AgentFeatureContext(BaseModel):
    label: str
    track_id: str
    kind: TrackKind
    chrom: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class AgentChatRequest(BaseModel):
    message: str = Field(min_length=2, max_length=500)
    assembly: str = Field(default="hg38", min_length=2, max_length=64)
    thread_id: str | None = Field(default=None, max_length=128)
    region: AgentRegion | None = None
    regions: list[AgentRegion] = Field(default_factory=list, max_length=8)
    feature: AgentFeatureContext | None = None


class AgentGeneLink(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    symbol: str
    name: str | None = None
    assembly: str
    chrom: str
    start: int
    end: int
    score: float | None = None
    source_url: str | None = None


class AgentMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    value: str
    tone: Literal["neutral", "positive", "warning"] = "neutral"


class AgentSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    url: str


class AgentVariant(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    assembly: str
    chrom: str
    start: int
    end: int
    ref: str | None = None
    alt: str | None = None
    hgvs: str | None = None
    significance: str | None = None
    review_status: str | None = None
    consequence: str | None = None
    conditions: list[str] = Field(default_factory=list)
    distance: int | None = None
    source_url: str | None = None


class AgentFeatureLink(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    kind: TrackKind
    assembly: str
    chrom: str
    start: int
    end: int
    category: str | None = None
    context: str | None = None
    score: float | None = None
    value: float | None = None
    distance: int | None = None
    source_url: str | None = None


class AgentRegionLink(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    assembly: str
    chrom: str
    start: int
    end: int
    description: str | None = None


class AgentAssumption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    value: str


class AgentAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["focus", "add_range", "add_track"]
    label: str
    region: AgentRegion | None = None
    highlight_region: AgentRegion | None = None
    track_id: str | None = None


class AgentEvidenceRelation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject_id: str
    predicate: Literal["overlaps", "nearby", "derived_from", "annotates"]
    object_id: str
    source: str


class QueryEntity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["gene", "variant", "disease", "context", "vcf"]
    value: str


class QueryRangeExpression(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["context", "gene", "promoter", "around"]
    upstream_bp: int = Field(default=2000, ge=0, le=1_000_000)
    downstream_bp: int = Field(default=200, ge=0, le=1_000_000)
    radius_bp: int = Field(default=50_000, ge=1, le=2_500_000)
    transcript_policy: Literal["mane", "canonical", "all"] = "mane"


class QueryFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clinical_significance: list[str] = Field(default_factory=list)
    biosample: str | None = None
    regulatory_classes: list[str] = Field(default_factory=list)


class QueryPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Literal["genomic_evidence", "disease_genes", "help"]
    assembly: str
    entities: list[QueryEntity] = Field(default_factory=list)
    range: QueryRangeExpression
    evidence: list[AgentEvidenceSource] = Field(default_factory=list)
    filters: QueryFilters
    output: Literal["summary", "variant_table", "feature_table", "evidence_matrix"]


class AgentStructuredAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["disease_genes", "region_context", "genomic_query", "help"]
    title: str
    summary: str
    genes: list[AgentGeneLink] = Field(default_factory=list)
    metrics: list[AgentMetric] = Field(default_factory=list)
    sources: list[AgentSource] = Field(default_factory=list)
    variants: list[AgentVariant] = Field(default_factory=list)
    features: list[AgentFeatureLink] = Field(default_factory=list)
    regions: list[AgentRegionLink] = Field(default_factory=list)
    assumptions: list[AgentAssumption] = Field(default_factory=list)
    actions: list[AgentAction] = Field(default_factory=list)
    relations: list[AgentEvidenceRelation] = Field(default_factory=list)
    result_complete: bool = True
    caveat: str | None = None


class AgentChatResponse(AgentStructuredAnswer):
    thread_id: str | None = None
    backend: Literal["grounded_rules", "anthropic_api"] = "grounded_rules"
