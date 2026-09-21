import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db
from .routes import generate, history, samples, uploads

BASE_DIR = Path(__file__).resolve().parent

# bumped on every process start so browsers don't serve stale cached JS/CSS during dev
ASSET_VERSION = str(int(time.time()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    yield


app = FastAPI(title="AIdols", lifespan=lifespan)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")

app.include_router(uploads.router)
app.include_router(samples.router)
app.include_router(generate.router)
app.include_router(history.router)


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(
        request, "index.html", {"asset_version": ASSET_VERSION}
    )
