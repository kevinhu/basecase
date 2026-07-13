from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from app.models import (
    GeneSearchResponse,
    TrackCatalogResponse,
    TrackFeaturesResponse,
    TrackKind,
    TrackSchemaResponse,
)
from app.mygene import MyGeneError, mygene_client
from app.ucsc import UCSCError, ucsc_client

router = APIRouter(prefix="/api/ucsc", tags=["UCSC"])


@router.get("/genes/search", response_model=GeneSearchResponse)
async def search_genes(
    query: Annotated[str, Query(min_length=2, max_length=100)],
    assembly: Annotated[str, Query(min_length=2, max_length=64)] = "hg38",
) -> GeneSearchResponse:
    try:
        try:
            fast_results = await mygene_client.search_genes(assembly, query)
            if fast_results.results:
                return fast_results
        except MyGeneError:
            pass
        return await ucsc_client.search_genes(assembly, query)
    except UCSCError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/tracks", response_model=TrackCatalogResponse)
async def list_tracks(
    assembly: Annotated[str, Query(min_length=2, max_length=64)] = "hg38",
    query: Annotated[str | None, Query(max_length=100)] = None,
    kind: Annotated[TrackKind | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TrackCatalogResponse:
    try:
        return await ucsc_client.catalog(assembly, query, kind, limit, offset)
    except UCSCError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/tracks/{track_id}/schema", response_model=TrackSchemaResponse)
async def get_track_schema(
    track_id: Annotated[str, Path(min_length=1, max_length=200)],
    assembly: Annotated[str, Query(min_length=2, max_length=64)] = "hg38",
) -> TrackSchemaResponse:
    try:
        return await ucsc_client.schema(assembly, track_id)
    except UCSCError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/tracks/{track_id}/features", response_model=TrackFeaturesResponse)
async def get_track_features(
    track_id: Annotated[str, Path(min_length=1, max_length=200)],
    chrom: Annotated[str, Query(min_length=1, max_length=128)],
    start: Annotated[int, Query(ge=0)],
    end: Annotated[int, Query(gt=0)],
    assembly: Annotated[str, Query(min_length=2, max_length=64)] = "hg38",
    max_items: Annotated[int, Query(ge=1, le=100_000)] = 250,
) -> TrackFeaturesResponse:
    if end <= start:
        raise HTTPException(status_code=422, detail="end must be greater than start")
    if end - start > 5_000_000:
        raise HTTPException(status_code=422, detail="region cannot exceed 5 Mb")
    try:
        return await ucsc_client.features(assembly, track_id, chrom, start, end, max_items)
    except UCSCError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
