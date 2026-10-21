// Utilidades compartidas. Vercel no publica como endpoint los archivos que
// empiezan con "_", así que esto no queda expuesto en /api.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const BUSINESS_TZ = process.env.BUSINESS_TZ || "America/Mexico_City";

// Fecha "hoy" en la zona horaria del negocio, como YYYY-MM-DD (no UTC).
export function todayInTz(tz = BUSINESS_TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

// Lee ?since=YYYY-MM-DD&until=YYYY-MM-DD. Por defecto: 1 de enero del año
// en curso hasta hoy. El frontend filtra rangos más cortos en el navegador.
export function readRange(query = {}) {
  const until = query.until || todayInTz();
  const since = query.since || `${until.slice(0, 4)}-01-01`;
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) {
    throw Object.assign(new Error("Formato de fecha inválido; usa YYYY-MM-DD"), { status: 400 });
  }
  if (since > until) {
    throw Object.assign(new Error("'since' no puede ser posterior a 'until'"), { status: 400 });
  }
  return { since, until };
}

export const num = (v) => (v === undefined || v === null || v === "" ? 0 : parseFloat(v));

// Caché en memoria por instancia caliente (no es durable entre cold starts).
export function makeCache(ttlMs) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.data : null;
    },
    set(key, data) {
      store.set(key, { data, at: Date.now() });
    },
  };
}

export function sendError(res, platform, err) {
  console.error(`${platform} error:`, err);
  return res.status(err.status || 502).json({
    error: `No se pudo obtener datos de ${platform}`,
    detail: err.message || String(err),
  });
}

// Suma días a un 'YYYY-MM-DD' sin pasar por zonas horarias.
export function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function localDate(iso, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
}
