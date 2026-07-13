import httpx
import pytest

from app.mygene import MyGeneClient, normalize_mygene_results


def test_normalize_mygene_results_ranks_exact_symbol_first() -> None:
    hits = [
        {
            "_id": "2885",
            "_score": 2.0,
            "symbol": "GRB2",
            "alias": ["EGFRBP-GRB2"],
            "name": "growth factor receptor bound protein 2",
            "genomic_pos": {"chr": "17", "start": 100, "end": 200},
        },
        {
            "_id": "1956",
            "_score": 1.5,
            "symbol": "EGFR",
            "alias": ["ERBB1"],
            "name": "epidermal growth factor receptor",
            "genomic_pos": {"chr": "7", "start": 300, "end": 400},
        },
    ]

    results = normalize_mygene_results("hg38", "EGFR", "genomic_pos", hits)

    assert [result.symbol for result in results] == ["EGFR", "GRB2"]
    assert results[0].chrom == "chr7"
    assert results[0].start == 300
    assert results[0].end == 401


@pytest.mark.anyio
async def test_mygene_client_caches_queries() -> None:
    request_count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        assert _request.url.params["q"].startswith("symbol:BRCA OR alias:BRCA OR")
        return httpx.Response(
            200,
            json={
                "hits": [
                    {
                        "_id": "672",
                        "symbol": "BRCA1",
                        "name": "BRCA1 DNA repair associated",
                        "genomic_pos": {"chr": "17", "start": 43044292, "end": 43170245},
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = MyGeneClient(http_client)
        first = await client.search_genes("hg38", "BRCA")
        second = await client.search_genes("hg38", "BRCA")

    assert first.results[0].symbol == "BRCA1"
    assert second.results[0].symbol == "BRCA1"
    assert request_count == 1
