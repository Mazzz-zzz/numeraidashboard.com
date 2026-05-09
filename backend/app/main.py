from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import ml

app = FastAPI(
    title="Numerai Dashboard API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ml.router, prefix="/api", tags=["ml"])


@app.get("/health")
async def health():
    return {"status": "ok"}
