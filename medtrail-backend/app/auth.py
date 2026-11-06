"""
Who is calling. Two modes:
  AUTH_MODE=demo  -> header X-Demo-User picks one of the synthetic demo users (hackathon demo)
  AUTH_MODE=jwt   -> Authorization: Bearer <JWT> (HS256), e.g. Supabase Auth.
                     Role comes from the token's app_metadata.role, never from the client.
"""
from dataclasses import asdict, dataclass

from starlette.requests import Request

from .config import settings
from .errors import ApiError


@dataclass(frozen=True)
class User:
    id: str
    name: str
    role: str  # patient | pharmacist | clinician
    patient_id: str | None = None

    @property
    def is_staff(self) -> bool:
        return self.role in ("pharmacist", "clinician")

    def public(self):
        d = asdict(self)
        d["patientId"] = d.pop("patient_id")
        return d

    def ref(self):
        return {"id": self.id, "name": self.name, "role": self.role}


DEMO_USERS = [
    User("u-iyer", "R. Iyer", "pharmacist"),
    User("u-shah", "A. Shah", "pharmacist"),
    User("u-rao", "Dr. P. Rao", "clinician"),
    User("u-arun", "Arun Kumar", "patient", "SYN-20481"),
]
SIM_USERS = [User(f"sim-{i}", f"Sim pharmacist {i}", "pharmacist") for i in range(1, 6)]
SYSTEM = User("system", "MedTrail extraction", "system")
ENGINE = User("engine", "Comparison engine", "system")


def _demo_user(request: Request) -> User:
    uid = request.headers.get("x-demo-user")
    if not uid:
        raise ApiError(401, "UNAUTHENTICATED", "Send the X-Demo-User header (demo mode).")
    pool = DEMO_USERS + (SIM_USERS if settings.demo_mode else [])
    for u in pool:
        if u.id == uid:
            return u
    raise ApiError(401, "UNKNOWN_USER", f"Unknown demo user {uid}.")


def _jwt_user(request: Request) -> User:
    import jwt  # PyJWT

    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise ApiError(401, "UNAUTHENTICATED", "Sign in required.")
    try:
        claims = jwt.decode(
            auth[7:],
            settings.jwt_secret,
            algorithms=["HS256"],
            audience=settings.jwt_audience,
            options={"verify_aud": settings.jwt_audience is not None},
        )
    except jwt.PyJWTError as exc:
        raise ApiError(401, "INVALID_TOKEN", "Your session has expired. Please sign in again.") from exc
    app_meta = claims.get("app_metadata") or {}
    user_meta = claims.get("user_metadata") or {}
    role = app_meta.get("role") or claims.get("role")
    if role not in ("patient", "pharmacist", "clinician"):
        raise ApiError(403, "NO_ROLE", "Your account has no MedTrail role yet.")
    return User(
        id=claims["sub"],
        name=user_meta.get("name") or claims.get("name") or claims.get("email") or "User",
        role=role,
        patient_id=app_meta.get("patient_id"),
    )


def current_user(request: Request) -> User:
    return _jwt_user(request) if settings.auth_mode == "jwt" else _demo_user(request)


def require_staff(user: User):
    if not user.is_staff:
        raise ApiError(403, "FORBIDDEN", "Only pharmacists and clinicians can do this.")


def require_patient_access(user: User, patient_id: str):
    if user.role == "patient" and user.patient_id != patient_id:
        raise ApiError(403, "FORBIDDEN", "You can only see your own records.")
