// Runs before every test file, before any application module reads process.env.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "error";
// The global limiter is keyed by IP and every test client shares one address.
process.env.ENABLE_RATE_LIMIT = "false";
process.env.DATABASE_SSL ??= "false";
// Long enough that "just rotated" is deterministic; tests backdate rotation to leave the window.
process.env.AUTH_REFRESH_REUSE_GRACE = "30s";
