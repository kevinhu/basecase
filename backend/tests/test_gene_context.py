from app.gene_context import normalize_expression, normalize_literature, tissue_name


def test_normalize_literature() -> None:
    result = normalize_literature(
        "BRCA1",
        {
            "count": 12,
            "results": [
                {
                    "pmid": 123,
                    "title": "A BRCA1 study",
                    "journal": "Genome Med",
                    "date": "2025-03-01T00:00:00Z",
                    "authors": ["Smith A", "Lee B"],
                    "score": 42.5,
                }
            ],
        },
    )

    assert result.total == 12
    assert result.articles[0].pmid == "123"
    assert result.articles[0].year == 2025
    assert result.articles[0].authors == ["Smith A", "Lee B"]


def test_normalize_expression_sorts_tissues() -> None:
    result = normalize_expression(
        "BRCA1",
        "ENSG00000012048.23",
        {
            "data": [
                {"tissueSiteDetailId": "Lung", "median": 2.0, "unit": "TPM"},
                {
                    "tissueSiteDetailId": "Breast_Mammary_Tissue",
                    "median": 4.5,
                    "unit": "TPM",
                    "ontologyId": "UBERON:0001911",
                },
            ]
        },
    )

    assert result.dataset_id == "gtex_v10"
    assert result.tissues[0].tissue_name == "Breast — Mammary Tissue"
    assert result.tissues[0].median == 4.5
    assert tissue_name("Whole_Blood") == "Whole — Blood"
