// GET /api/ga4?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1]
//   → totales del rango para el embudo del Resumen.
// GET /api/ga4?view=web&since=...&until=...&prevSince=...&prevUntil=...
//   → todo lo de la pestaña Web: KPIs (actual y anterior), embudo por sesiones,
//     diario, canales, fuente/medio, dispositivos, páginas de entrada, productos y estados.
//
// GA4 Data API por REST (sin SDK). Autenticación con service account firmando
// un JWT con la librería crypto de Node (cero dependencias).
//
// Variables de entorno:
//   GA4_PROPERTY_ID               ID numérico de la propiedad (no el "G-XXXX")
//   GOOGLE_SERVICE_ACCOUNT_JSON   contenido completo del JSON de la service account;
//                                 su correo debe tener rol Lector en la propiedad de GA4
//
// Devuelve totales del rango: sesiones, usuarios y eventos del embudo.

import crypto from "node:crypto";
import { readRange, num, makeCache, sendError } from "./_lib/range.js";

const cache = makeCache(10 * 60 * 1000);
let tokenCache = { token: null, expiresAt: 0 };
const FUNNEL_EVENTS = ["view_item", "add_to_cart", "begin_checkout", "purchase"];
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON en las variables de entorno");
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido: pega el contenido completo del archivo"); }
  if (!sa.client_email || !sa.private_key) throw new Error("El JSON de la service account no trae client_email o private_key");
  return { email: sa.client_email, key: sa.private_key.replace(/\\n/g, "\n") };
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const { email, key } = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`No se pudo autenticar la service account: ${json.error || ""} ${json.error_description || ""}`.trim());
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return tokenCache.token;
}

async function runReport(body) {
  const id = (process.env.GA4_PROPERTY_ID || "").replace(/^properties\//, "").trim();
  if (!id) throw new Error("Falta GA4_PROPERTY_ID en las variables de entorno");
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    const hint = res.status === 403 ? " (agrega el correo de la service account como Lector en la propiedad de GA4 y revisa que la Google Analytics Data API esté habilitada en su proyecto)" : "";
    throw new Error(`${msg}${hint}`);
  }
  return json;
}

async function fetchGA4(since, until) {
  const dateRanges = [{ startDate: since, endDate: until }];
  const [totals, events] = await Promise.all([
    runReport({ dateRanges, metrics: [{ name: "sessions" }, { name: "totalUsers" }] }),
    runReport({
      dateRanges, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: FUNNEL_EVENTS } } },
    }),
  ]);
  const t = totals.rows?.[0]?.metricValues || [];
  const ev = Object.fromEntries(FUNNEL_EVENTS.map((e) => [e, 0]));
  for (const r of events.rows || []) ev[r.dimensionValues[0].value] = num(r.metricValues[0].value);
  return { sessions: num(t[0]?.value), users: num(t[1]?.value), events: ev };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (row, i) => num(row.metricValues[i]?.value);
const dims = (row) => row.dimensionValues.map((d) => d.value);
const FUNNEL = ["view_item", "add_to_cart", "begin_checkout", "purchase"];

// GA4 entrega los estados en inglés y sin acentos
const REGION_ES = {
  "Mexico City": "Ciudad de México", "State of Mexico": "Estado de México", "Nuevo Leon": "Nuevo León", "Queretaro": "Querétaro",
  "Michoacan": "Michoacán", "San Luis Potosi": "San Luis Potosí", "Yucatan": "Yucatán", "Coahuila": "Coahuila", "Baja California Sur": "Baja California Sur",
  "Baja California": "Baja California", "Quintana Roo": "Quintana Roo", "Guanajuato": "Guanajuato", "Jalisco": "Jalisco", "Puebla": "Puebla", "Veracruz": "Veracruz",
  "Hidalgo": "Hidalgo", "Morelos": "Morelos", "Chihuahua": "Chihuahua", "Sonora": "Sonora", "Sinaloa": "Sinaloa", "Tamaulipas": "Tamaulipas", "Oaxaca": "Oaxaca",
  "Chiapas": "Chiapas", "Tabasco": "Tabasco", "Campeche": "Campeche", "Guerrero": "Guerrero", "Aguascalientes": "Aguascalientes", "Zacatecas": "Zacatecas",
  "Durango": "Durango", "Nayarit": "Nayarit", "Colima": "Colima", "Tlaxcala": "Tlaxcala", "(not set)": "Sin dato",
};

async function fetchWeb(since, until, prevSince, prevUntil) {
  const cur = { startDate: since, endDate: until, name: "cur" };
  const ranges = prevSince ? [cur, { startDate: prevSince, endDate: prevUntil, name: "prev" }] : [cur];
  const only = [{ startDate: since, endDate: until }];
  const BASE_M = ["sessions", "engagementRate", "addToCarts", "ecommercePurchases", "purchaseRevenue"].map((name) => ({ name }));
  const eventFilter = { filter: { fieldName: "eventName", inListFilter: { values: FUNNEL } } };

  const [summary, funnel, daily, channels, sources, devices, devFunnel, landing, products, regions] = await Promise.all([
    // 1. KPIs: actual vs anterior (dateRange llega como dimensión cuando hay dos rangos)
    runReport({ dateRanges: ranges, metrics: ["sessions", "totalUsers", "newUsers", "engagementRate", "userEngagementDuration", "screenPageViews", "ecommercePurchases", "purchaseRevenue", "addToCarts", "checkouts"].map((name) => ({ name })) }),
    // 2. Embudo por sesiones: sesiones en las que ocurrió cada evento
    runReport({ dateRanges: ranges, dimensions: [{ name: "eventName" }], metrics: [{ name: "sessions" }, { name: "eventCount" }], dimensionFilter: eventFilter }),
    runReport({ dateRanges: only, dimensions: [{ name: "date" }], metrics: BASE_M, orderBys: [{ dimension: { dimensionName: "date" } }] }),
    runReport({ dateRanges: only, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: BASE_M }),
    runReport({ dateRanges: only, dimensions: [{ name: "sessionSourceMedium" }], metrics: BASE_M, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 100 }),
    runReport({ dateRanges: only, dimensions: [{ name: "deviceCategory" }], metrics: [...BASE_M, { name: "userEngagementDuration" }] }),
    runReport({ dateRanges: only, dimensions: [{ name: "deviceCategory" }, { name: "eventName" }], metrics: [{ name: "sessions" }], dimensionFilter: eventFilter }),
    runReport({ dateRanges: only, dimensions: [{ name: "landingPage" }], metrics: BASE_M, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 50 }),
    runReport({ dateRanges: only, dimensions: [{ name: "itemName" }], metrics: ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"].map((name) => ({ name })), orderBys: [{ metric: { metricName: "itemsViewed" }, desc: true }], limit: 100 }),
    runReport({ dateRanges: only, dimensions: [{ name: "region" }], metrics: BASE_M, dimensionFilter: { filter: { fieldName: "countryId", stringFilter: { value: "MX" } } }, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 40 }),
  ]);

  // Con dos rangos, GA4 agrega la dimensión "dateRange" al final de cada fila
  const byRange = (rep, mapRow) => {
    const out = { cur: null, prev: null };
    for (const row of rep.rows || []) {
      const d = dims(row); const key = prevSince ? d[d.length - 1] : "cur";
      out[key] = mapRow(row, d, out[key]);
    }
    return out;
  };
  const kpi = byRange(summary, (row) => ({
    sessions: n(row, 0), users: n(row, 1), newUsers: n(row, 2), engagementRate: n(row, 3), engagementSeconds: n(row, 4),
    pageViews: n(row, 5), purchases: n(row, 6), revenue: n(row, 7), addToCarts: n(row, 8), checkouts: n(row, 9),
  }));
  const fun = byRange(funnel, (row, d, acc) => { const a = acc || {}; a[d[0]] = { sessions: n(row, 0), events: n(row, 1) }; return a; });

  const base = (row, d) => ({ name: d[0], sessions: n(row, 0), engagementRate: n(row, 1), addToCarts: n(row, 2), purchases: n(row, 3), revenue: n(row, 4) });
  const deviceFunnel = {};
  for (const row of devFunnel.rows || []) { const [dev, ev] = dims(row); (deviceFunnel[dev] ||= {})[ev] = n(row, 0); }

  return {
    kpi, funnel: fun,
    daily: (daily.rows || []).map((row) => { const d = dims(row)[0]; return { ...base(row, [d]), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` }; }),
    channels: (channels.rows || []).map((row) => base(row, dims(row))),
    sources: (sources.rows || []).map((row) => base(row, dims(row))),
    devices: (devices.rows || []).map((row) => ({ ...base(row, dims(row)), engagementSeconds: n(row, 5) })),
    deviceFunnel,
    landing: (landing.rows || []).map((row) => base(row, dims(row))),
    products: (products.rows || []).map((row) => ({ name: dims(row)[0], views: n(row, 0), addToCarts: n(row, 1), purchased: n(row, 2), revenue: n(row, 3) })),
    regions: (regions.rows || []).map((row) => { const b = base(row, dims(row)); return { ...b, name: REGION_ES[b.name] || b.name }; }),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { since, until } = readRange(req.query);
    const view = req.query.view === "web" ? "web" : "summary";
    const { prevSince, prevUntil } = req.query;
    if (view === "web" && prevSince && (!DATE_RE.test(prevSince) || !DATE_RE.test(prevUntil || ""))) {
      return res.status(400).json({ error: "prevSince/prevUntil deben ser YYYY-MM-DD" });
    }
    const key = `${view}_${since}_${until}_${prevSince || ""}_${prevUntil || ""}`;
    let data = req.query.refresh === "1" ? null : cache.get(key);
    if (!data) {
      const payload = view === "web" ? await fetchWeb(since, until, prevSince, prevUntil) : await fetchGA4(since, until);
      data = { source: "ga4", view, since, until, ...payload, fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, "GA4", err);
  }
}
