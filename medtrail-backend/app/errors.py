from starlette.requests import Request
from starlette.responses import JSONResponse


class ApiError(Exception):
    """Raise anywhere; returned to the client as {"error": CODE, "message": "...", ...extra}."""

    def __init__(self, status: int, code: str, message: str, headers: dict | None = None, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}
        self.extra = extra


def fail(status: int, code: str, message: str, **extra):
    """Business-rule rejection returned from a write handler (stored for idempotent replay)."""
    return status, {"error": code, "message": message, **extra}


async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse({"error": exc.code, "message": exc.message, **exc.extra}, status_code=exc.status, headers=exc.headers)


def ok(body, status: int = 200):
    return status, body
