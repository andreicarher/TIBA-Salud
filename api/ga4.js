// GET /api/ga4?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1]
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

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { since, until } = readRange(req.query);
    const key = `${since}_${until}`;
    let data = req.query.refresh === "1" ? null : cache.get(key);
    if (!data) {
      data = { source: "ga4", since, until, ...(await fetchGA4(since, until)), fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, "GA4", err);
  }
}
