from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from file_manager import router as file_router
from terminal import router as terminal_router
from ai import router as ai_router

app = FastAPI(title="AI IDE Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(file_router, prefix="/files")
app.include_router(terminal_router, prefix="/terminal")
app.include_router(ai_router, prefix="/ai")

@app.get("")
def root():
    return {"status": "AI IDE Backend Running"}

@app.get("/health")
def health():
    return {"status": "healthy"}