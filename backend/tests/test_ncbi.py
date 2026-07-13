from app.ncbi import normalize_gene_summary


def test_normalize_gene_summary() -> None:
    summary = normalize_gene_summary(
        "BRCA1",
        "672",
        {
            "name": "BRCA1",
            "nomenclaturesymbol": "BRCA1",
            "nomenclaturename": "BRCA1 DNA repair associated",
            "nomenclaturestatus": "Official",
            "summary": "Maintains genomic stability.",
            "chromosome": "17",
            "maplocation": "17q21.31",
            "otheraliases": "BRCAI, FANCS",
            "mim": ["113705"],
            "genomicinfo": [{"exoncount": 31}],
        },
    )

    assert summary.symbol == "BRCA1"
    assert summary.full_name == "BRCA1 DNA repair associated"
    assert summary.aliases == ["BRCAI", "FANCS"]
    assert summary.map_location == "17q21.31"
    assert summary.mim_ids == ["113705"]
    assert summary.exon_count == 31
