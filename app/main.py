import hashlib
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from starlette.status import HTTP_303_SEE_OTHER

from . import auth, config, db, fal_service
from .routes import estimate, generate, history, samples, uploads

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# path -> (mtime_ns, size, digest). Keyed on a stat so editing a file locally
# picks up immediately without a restart, while a served request only pays for
# the stat, not a re-hash.
_asset_hashes: dict[str, tuple[int, int, str]] = {}


def static_url(path: str) -> str:
    """/static/<path> tagged with a hash of its contents.

    A timestamp bumped at process start looked equivalent but wasn't: each
    serverless instance minted its own, so identical files were served under
    several URLs — fragmenting the CDN cache and making a stale asset hard to
    tell from a fresh one. A content hash changes when, and only when, the file
    does.
    """
    file = STATIC_DIR / path
    try:
        stat = file.stat()
    except OSError:
        return f"/static/{path}"

    cached = _asset_hashes.get(path)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return f"/static/{path}?v={cached[2]}"

    digest = hashlib.sha256(file.read_bytes()).hexdigest()[:12]
    _asset_hashes[path] = (stat.st_mtime_ns, stat.st_size, digest)
    return f"/static/{path}?v={digest}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    yield


app = FastAPI(title="AIdols", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=config.SESSION_SECRET,
    same_site="lax",
    max_age=config.SESSION_MAX_AGE,
)

# left unauthenticated: it holds no secrets, and gating it would break the
# login page's own stylesheet
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")
templates.env.globals["static_url"] = static_url

_protected = [Depends(auth.require_auth)]
app.include_router(uploads.router, dependencies=_protected)
app.include_router(samples.router, dependencies=_protected)
app.include_router(generate.router, dependencies=_protected)
app.include_router(history.router, dependencies=_protected)
app.include_router(estimate.router, dependencies=_protected)


def _login_page(request: Request, error: str | None = None, status_code: int = 200):
    return templates.TemplateResponse(
        request,
        "login.html",
        {
            "error": error,
            "credentials_configured": auth.credentials_configured(),
        },
        status_code=status_code,
    )


@app.get("/login")
def login_form(request: Request):
    if auth.is_authenticated(request):
        return RedirectResponse("/", status_code=HTTP_303_SEE_OTHER)
    return _login_page(request)


@app.post("/login")
def login(request: Request, username: str = Form(""), password: str = Form("")):
    if not auth.credentials_configured():
        return _login_page(
            request,
            error="Login is not configured — set AUTH_USERNAME and AUTH_PASSWORD.",
            status_code=503,
        )
    if not auth.verify_credentials(username, password):
        return _login_page(request, error="Incorrect username or password.", status_code=401)

    auth.sign_in(request)
    return RedirectResponse("/", status_code=HTTP_303_SEE_OTHER)


@app.post("/logout")
def logout(request: Request):
    auth.sign_out(request)
    return RedirectResponse("/login", status_code=HTTP_303_SEE_OTHER)


@app.get("/")
def index(request: Request):
    if not auth.is_authenticated(request):
        return RedirectResponse("/login", status_code=HTTP_303_SEE_OTHER)
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "username": config.AUTH_USERNAME,
            "model_label": fal_service.MODELS[fal_service.DEFAULT_MODEL_KEY].label,
        },
    )
