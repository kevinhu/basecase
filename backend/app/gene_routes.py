from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from app.gene_context import GeneContextError, gene_context_client
from app.models import GeneExpressionResponse, GeneLiteratureResponse, GeneSummaryResponse
from app.ncbi import NCBIError, ncbi_client

router = APIRouter(prefix="/api/genes", tags=["Genes"])


@router.get("/{symbol}/summary", response_model=GeneSummaryResponse)
async def gene_summary(
    symbol: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")],
) -> GeneSummaryResponse:
    try:
        return await ncbi_client.gene_summary(symbol)
    except NCBIError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/{symbol}/literature", response_model=GeneLiteratureResponse)
async def gene_literature(
    symbol: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")],
    limit: Annotated[int, Query(ge=1, le=10)] = 5,
) -> GeneLiteratureResponse:
    try:
        return await gene_context_client.literature(symbol, limit)
    except GeneContextError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/{symbol}/expression", response_model=GeneExpressionResponse)
async def gene_expression(
    symbol: Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")],
) -> GeneExpressionResponse:
    try:
        return await gene_context_client.expression(symbol)
    except GeneContextError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
