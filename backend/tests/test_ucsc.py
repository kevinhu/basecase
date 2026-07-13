from datetime import UTC, datetime

from app.models import TrackFeaturesResponse
from app.ucsc import (
    composite_track_definitions,
    downsample_population_density,
    downsample_signal,
    infer_kind,
    merge_composite_features,
    normalize_feature,
    normalize_gene_search_results,
    normalize_track,
    track_search_score,
)


def test_normalize_mane_track() -> None:
    track = normalize_track(
        "hg38",
        "mane",
        {
            "shortLabel": "MANE",
            "longLabel": "MANE Select Plus Clinical",
            "type": "bigGenePred",
            "group": "genes",
            "bigDataUrl": "/gbdb/hg38/mane/mane.bb",
        },
    )

    assert track.kind == "gene"
    assert track.default_visible is True
    assert track.source_url == "https://genome.ucsc.edu/gbdb/hg38/mane/mane.bb"


def test_normalize_signal_feature() -> None:
    feature = normalize_feature(
        "hg38",
        "phyloP100way",
        {"chrom": "chr17", "start": 10, "end": 11, "value": 2.5},
        0,
    )

    assert feature.start == 10
    assert feature.end == 11
    assert feature.value == 2.5


def test_normalize_refseq_genepred_coordinates() -> None:
    feature = normalize_feature(
        "hg38",
        "ncbiRefSeqCurated",
        {
            "chrom": "chr17",
            "txStart": 100,
            "txEnd": 250,
            "name": "NM_1.1",
            "name2": "GENE1",
            "exonStarts": "100,200,",
            "exonEnds": "150,250,",
        },
        0,
    )

    assert feature.start == 100
    assert feature.end == 250
    assert feature.label == "GENE1"


def test_normalize_repeatmasker_coordinates() -> None:
    feature = normalize_feature(
        "hg38",
        "rmsk",
        {
            "genoName": "chr17",
            "genoStart": 100,
            "genoEnd": 125,
            "repName": "AluSx",
            "repClass": "SINE",
        },
        0,
    )

    assert feature.chrom == "chr17"
    assert feature.start == 100
    assert feature.end == 125
    assert feature.label == "AluSx"


def test_multiz_score_is_renderable_signal() -> None:
    feature = normalize_feature(
        "hg38",
        "multiz100way",
        {"chrom": "chr17", "chromStart": 10, "chromEnd": 20, "score": 0.75},
        0,
    )

    assert feature.value == 0.75


def test_infer_track_kinds() -> None:
    assert infer_kind("clinvarMain", "bigBed 12 +", "phenDis") == "variant"
    assert infer_kind("cCREregistry", "bigBed 9 + 5", "regulation") == "regulatory"


def test_downsample_signal() -> None:
    features = [
        normalize_feature(
            "hg38",
            "phyloP100way",
            {"chrom": "chr17", "start": index, "end": index + 1, "value": float(index)},
            index,
        )
        for index in range(10)
    ]

    downsampled = downsample_signal(features, target_points=2)

    assert len(downsampled) == 2
    assert downsampled[0].start == 0
    assert downsampled[0].end == 5
    assert downsampled[0].value == 2.0


def test_normalize_gene_search_prefers_hgnc() -> None:
    results = normalize_gene_search_results(
        "hg38",
        "MDM",
        [
            {
                "name": "hgnc",
                "trackName": "hgnc",
                "matches": [
                    {
                        "position": "chr1:204516379-204558120",
                        "posName": "MDM4",
                        "hgFindMatches": "HGNC%3A6974",
                        "description": "MDM4 regulator of p53",
                    }
                ],
            },
            {
                "name": "knownGene",
                "matches": [
                    {
                        "position": "chr1:1-2",
                        "posName": "UNRELATED",
                        "description": "mentions MDM4",
                    }
                ],
            },
        ],
    )

    assert len(results) == 1
    assert results[0].symbol == "MDM4"
    assert results[0].chrom == "chr1"


def test_composite_tracks_are_default_visible() -> None:
    tracks = {track.id: track for track in composite_track_definitions("hg38")}

    assert tracks["gnomadV4"].default_visible is True
    assert tracks["gnomadV4"].kind == "variant"
    assert tracks["sequenceContext"].default_visible is False
    assert tracks["sequenceContext"].kind == "repeat"


def test_merge_gnomad_preserves_exome_and_genome_frequency() -> None:
    exome = normalize_feature(
        "hg38",
        "gnomadExomesVariantsV4_1",
        {
            "chrom": "chr17",
            "chromStart": 10,
            "chromEnd": 11,
            "name": "exome-record",
            "ref": "A",
            "alt": "G",
            "AF": "0.001",
            "_displayName": "chr17-11-A-G",
        },
        0,
    )
    genome = normalize_feature(
        "hg38",
        "gnomadGenomesVariantsV4_1",
        {
            "chrom": "chr17",
            "chromStart": 10,
            "chromEnd": 11,
            "name": "genome-record",
            "ref": "A",
            "alt": "G",
            "AF": "0.002",
            "rsId": "rs1",
        },
        0,
    )
    now = datetime.now(UTC)
    responses = [
        TrackFeaturesResponse(
            assembly="hg38",
            track_id=feature.track_id,
            chrom="chr17",
            start=0,
            end=20,
            retrieved_at=now,
            truncated=False,
            features=[feature],
        )
        for feature in (exome, genome)
    ]

    merged = merge_composite_features("gnomadV4", responses)

    assert len(merged) == 1
    assert merged[0].track_id == "gnomadV4"
    assert merged[0].attributes["exomes_AF"] == "0.001"
    assert merged[0].attributes["genomes_AF"] == "0.002"
    assert merged[0].attributes["datasets"] == ["exomes", "genomes"]


def test_downsample_population_density_preserves_counts() -> None:
    features = [
        normalize_feature(
            "hg38",
            "gnomadV4",
            {
                "chrom": "chr17",
                "chromStart": index,
                "chromEnd": index + 1,
                "name": f"variant-{index}",
                "AF": str(index / 100),
            },
            index,
        )
        for index in range(10)
    ]

    density = downsample_population_density(features, 0, 10, bin_count=2)

    assert len(density) == 2
    assert sum(int(feature.attributes["density_count"]) for feature in density) == 10
    assert density[0].attributes["max_af"] == 0.04
    assert density[1].attributes["max_af"] == 0.09


def test_track_search_supports_unordered_tokens_and_ranking() -> None:
    track = normalize_track(
        "hg38",
        "clinvarMain",
        {
            "shortLabel": "ClinVar SNVs",
            "longLabel": "Clinical pathogenic and benign short variants",
            "type": "bigBed 12 +",
            "group": "phenDis",
        },
    )

    matched = track_search_score(track, ["pathogenic", "variant"], "pathogenic variant")
    exact = track_search_score(track, ["clinvar"], "clinvar")
    descriptive = track_search_score(track, ["clinical"], "clinical")

    assert matched is not None
    assert exact is not None
    assert descriptive is not None
    assert exact > descriptive
    assert track_search_score(track, ["mappability"], "mappability") is None
