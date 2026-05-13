"""
VS Code Marketplace extension proxy.
Forwards search/detail requests to the public Marketplace API so the
browser frontend avoids CORS restrictions.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

router = APIRouter()

MARKETPLACE_API = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
MARKETPLACE_HEADERS = {
    "Content-Type": "application/json;charset=utf-8",
    "Accept": "application/json;api-version=7.2-preview.1",
    "User-Agent": "NebulaIDE/1.0",
}

# FilterType values
FILTER_TARGET    = 8   # Microsoft.VisualStudio.Code
FILTER_SEARCH    = 10  # full-text search
FILTER_EXTENSION_ID = 4
FILTER_CATEGORY  = 5

# Flags bitmask  (includeVersions | includeFiles | includeStatistics | includeInstallationTargets | includeLatestVersionOnly)
FLAGS = 0x1 | 0x2 | 0x80 | 0x200 | 0x200

class SearchRequest(BaseModel):
    query: str = ""
    category: str = ""
    page: int = 1
    pageSize: int = 24
    sortBy: int = 4  # 0=default, 4=installs, 12=rating


def _build_body(req: SearchRequest) -> dict:
    criteria = [{"filterType": FILTER_TARGET, "value": "Microsoft.VisualStudio.Code"}]
    if req.query:
        criteria.append({"filterType": FILTER_SEARCH, "value": req.query})
    if req.category:
        criteria.append({"filterType": FILTER_CATEGORY, "value": req.category})
    return {
        "assetTypes": None,
        "filters": [{
            "criteria": criteria,
            "direction": 2,
            "pageSize": min(req.pageSize, 50),
            "pageNumber": req.page,
            "sortBy": req.sortBy,
            "sortOrder": 0,
            "pagingToken": None,
        }],
        "flags": 914,
    }


def _normalize(ext: dict) -> dict:
    """Flatten the nested Marketplace response into a flat dict the frontend uses."""
    versions  = ext.get("versions", [])
    latest    = versions[0] if versions else {}
    stats     = {s["statisticName"]: s["value"] for s in ext.get("statistics", [])}
    publisher = ext.get("publisher", {})

    icon_url = ""
    for f in latest.get("files", []):
        if f.get("assetType") == "Microsoft.VisualStudio.Services.Icons.Default":
            icon_url = f.get("source", "")
            break

    return {
        "id":            ext.get("extensionId", ""),
        "name":          ext.get("extensionName", ""),
        "displayName":   ext.get("displayName", ""),
        "description":   ext.get("shortDescription", ""),
        "publisher":     publisher.get("displayName", publisher.get("publisherName", "")),
        "publisherId":   publisher.get("publisherName", ""),
        "version":       latest.get("version", ""),
        "iconUrl":       icon_url,
        "installs":      int(stats.get("install", 0)),
        "rating":        round(stats.get("weightedRating", 0), 1),
        "ratingCount":   int(stats.get("ratingCount", 0)),
        "lastUpdated":   latest.get("lastUpdated", ""),
        "categories":    ext.get("categories", []),
        "tags":          ext.get("tags", []),
        "marketplaceUrl": f"https://marketplace.visualstudio.com/items?itemName={publisher.get('publisherName','')}.{ext.get('extensionName','')}",
    }


@router.get("/extensions/vsix")
async def download_vsix(publisher: str, name: str, version: str):
    """Proxy a .vsix download from the VS Code Marketplace (avoids CORS)."""
    url = f"https://marketplace.visualstudio.com/_apis/public/gallery/publishers/{publisher}/vsextensions/{name}/{version}/vspackage"
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "NebulaIDE/1.0"})
            resp.raise_for_status()
    except httpx.TimeoutException:
        raise HTTPException(502, "Marketplace timeout")
    except Exception as e:
        raise HTTPException(502, f"Marketplace error: {e}")

    from fastapi.responses import StreamingResponse
    import io
    return StreamingResponse(
        io.BytesIO(resp.content),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{publisher}.{name}-{version}.vsix"',
            "Content-Length": str(len(resp.content)),
        },
    )


@router.post("/extensions/search")
async def search_extensions(req: SearchRequest):
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(MARKETPLACE_API, json=_build_body(req), headers=MARKETPLACE_HEADERS)
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(502, "Marketplace timeout")
    except Exception as e:
        raise HTTPException(502, f"Marketplace error: {e}")

    results = data.get("results", [{}])
    exts    = results[0].get("extensions", []) if results else []
    total   = 0
    if results and results[0].get("resultMetadata"):
        for m in results[0]["resultMetadata"]:
            if m.get("metadataType") == "ResultCount":
                for item in m.get("metadataItems", []):
                    if item.get("name") == "TotalCount":
                        total = item.get("count", 0)
    return {"extensions": [_normalize(e) for e in exts], "total": total}
