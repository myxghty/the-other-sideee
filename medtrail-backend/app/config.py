"""All settings come from environment variables (see .env.example)."""
import os
import secrets


def _bool(value, default):
    if value is None or value == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    def __init__(self):
        # sqlite:///./medtrail.db for local dev, postgresql://user:pass@host/db in production
        self.database_url = os.getenv("DATABASE_URL", "sqlite:///./medtrail.db")
        self.db_pool_size = int(os.getenv("DB_POOL_SIZE", "10"))

        # demo: user picked with the X-Demo-User header (hackathon demo)
        # jwt:  Authorization: Bearer <token> signed with JWT_SECRET (e.g. Supabase Auth)
        self.auth_mode = os.getenv("AUTH_MODE", "demo")
        self.jwt_secret = os.getenv("JWT_SECRET", "")
        self.jwt_audience = os.getenv("JWT_AUDIENCE", "") or None

        # Enables /api/__demo/* (reset, stats, overload switch) and the simulated users.
        self.demo_mode = _bool(os.getenv("DEMO_MODE"), True)
        self.seed_on_start = _bool(os.getenv("SEED_ON_START"), True)

        # Load protection
        self.max_concurrency = int(os.getenv("MAX_CONCURRENCY", "24"))
        self.user_rate_per_sec = float(os.getenv("USER_RATE_PER_SEC", "30"))
        self.user_burst = int(os.getenv("USER_BURST", "100"))

        # Uploads
        self.storage_dir = os.getenv("STORAGE_DIR", "./storage")
        self.max_upload_bytes = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
        # Must be the same on every API instance in production.
        self.signing_secret = os.getenv("SIGNING_SECRET") or secrets.token_hex(32)
        self.run_worker_in_process = _bool(os.getenv("RUN_WORKER_IN_PROCESS"), True)

        self.cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

        self.claim_ttl_ms = 10 * 60 * 1000
        self.handover_ttl_ms = 15 * 60 * 1000
        self.idempotency_ttl_ms = 24 * 60 * 60 * 1000


settings = Settings()
