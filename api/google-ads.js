// GET /api/google-ads?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1]
// GET /api/google-ads?view=monthly&since=...&until=...   → inversión por mes
// GET /api/google-ads?view=keywords&since=...&until=...  → palabras clave con estado y métricas del periodo
//
// Google Ads API por REST (sin SDK). Filas diarias por campaña, sin agregar.
//
// Variables de entorno:
//   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET (OAuth del proyecto de Cloud con acceso a la API),
//   GOOGLE_ADS_DEVELOPER_TOKEN (opcional; Google ya no lo usa desde sep-2026),
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID (sin guiones),
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (sin guiones, solo si se accede vía MCC),
//   GOOGLE_ADS_API_VERSION (opcional, default v23)
//
// Recordatorios: la query va en snake_case y la respuesta llega en camelCase;
// los números llegan como string; nunca mandar pageSize; el error útil está
// en error.details[].errors[].message.

import { readRange, num, makeCache, sendError } from "./_lib/range.js";

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v23";
const cache = makeCache(10 * 60 * 1000);
let tokenCache = { accessToken: null, expiresAt: 0 };

const STATUS = { ENABLED: "Activa", PAUSED: "Pausada", REMOVED: "Eliminada" };
const stripDashes = (v) => (v || "").replace(/-/g, "");

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: (process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
      client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim(),
      refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || "").trim(),
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const hints = {
      invalid_grant: "el refresh token no es válido para este Client ID (mal copiado, de otro cliente OAuth, revocado o caducado)",
      invalid_client: "el Client ID o el Client Secret no son correctos o no corresponden entre sí",
      unauthorized_client: "el refresh token se generó con otro Client ID",
    };
    throw new Error(`Fallo al refrescar el token OAuth: ${json.error || "error"} — ${json.error_description || ""}${hints[json.error] ? ` (probable causa: ${hints[json.error]})` : ""}`);
  }
  tokenCache = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return tokenCache.accessToken;
}

function errorDetail(json) {
  const top = json?.error?.message || "Error desconocido de Google Ads API";
  const nested = (json?.error?.details || [])
    .flatMap((d) => d.errors || [])
    .map((e) => `${e.errorCode ? JSON.stringify(e.errorCode) + ": " : ""}${e.message}`);
  return nested.length ? `${top} — ${nested.join(" | ")}` : top;
}

async function gaql(query) {
  const customerId = stripDashes(process.env.GOOGLE_ADS_CUSTOMER_ID);
  if (!customerId) throw new Error("Falta GOOGLE_ADS_CUSTOMER_ID en las variables de entorno");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await getAccessToken()}`,
  };
  // Desde el 9-sep-2026 Google ignora el developer token: el nivel de acceso vive en el
  // proyecto de Google Cloud dueño del OAuth client. Solo se manda si existe la variable.
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) headers["developer-token"] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const login = stripDashes(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (login) headers["login-customer-id"] = login;

  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`;
  let rows = [];
  let pageToken;
  do {
    const body = pageToken ? { query, pageToken } : { query }; // sin pageSize, a propósito
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(errorDetail(json));
    rows = rows.concat(json.results || []);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return rows;
}

async function fetchGoogleAds(since, until) {
  const [info] = await gaql(`SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1`);

  // since/until ya vienen validados como YYYY-MM-DD por readRange().
  const campaignRows = await gaql(`
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
    ORDER BY segments.date ASC
  `);

  return {
    account: {
      id: stripDashes(process.env.GOOGLE_ADS_CUSTOMER_ID),
      name: info?.customer?.descriptiveName,
      currency: info?.customer?.currencyCode,
      timezone: info?.customer?.timeZone,
    },
    rows: campaignRows.map((r) => ({
      date: r.segments.date,
      campaign_id: r.campaign.id,
      campaign: r.campaign.name,
      status: STATUS[r.campaign.status] || r.campaign.status,
      channel_type: r.campaign.advertisingChannelType, // SEARCH, PERFORMANCE_MAX, SHOPPING…
      spend: num(r.metrics.costMicros) / 1_000_000,
      impressions: num(r.metrics.impressions),
      clicks: num(r.metrics.clicks),
      purchases: num(r.metrics.conversions),
      purchase_value: num(r.metrics.conversionsValue),
    })),
  };
}

// Palabras clave con actividad en el rango (totales del periodo, sin segmentar por día).
// Performance Max y Shopping no usan palabras clave, así que solo aparecen las de Search.
const KW_STATUS = { ENABLED: "Activo", PAUSED: "Pausado", REMOVED: "Quitado" };
const MATCH = { EXACT: "Exacta", PHRASE: "Frase", BROAD: "Amplia" };
async function fetchKeywords(since, until) {
  const rows = await gaql(`
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group.id,
      ad_group.name,
      ad_group.status,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.impressions,
      metrics.clicks
    FROM keyword_view
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `);
  return rows.map((r) => {
    const own = r.adGroupCriterion?.status;
    const parentPaused = r.campaign?.status !== "ENABLED" || r.adGroup?.status !== "ENABLED";
    return {
      id: `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`,
      keyword: r.adGroupCriterion?.keyword?.text || "(sin texto)",
      match: MATCH[r.adGroupCriterion?.keyword?.matchType] || r.adGroupCriterion?.keyword?.matchType || "",
      status: KW_STATUS[own] || own || "",
      // La palabra puede estar activa pero no publicarse si su campaña o grupo está en pausa
      parent_paused: own === "ENABLED" && parentPaused,
      ad_group: r.adGroup?.name,
      campaign: r.campaign?.name,
      spend: num(r.metrics?.costMicros) / 1_000_000,
      conversions: num(r.metrics?.conversions),
      conversions_value: num(r.metrics?.conversionsValue),
      impressions: num(r.metrics?.impressions),
      clicks: num(r.metrics?.clicks),
    };
  });
}

// Desglose mensual a nivel cuenta (para la gráfica Ene → hoy del Resumen).
async function fetchMonthly(since, until) {
  const rows = await gaql(`
    SELECT segments.month, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `);
  return rows.map((r) => ({
    month: (r.segments.month || "").slice(0, 7),
    spend: num(r.metrics.costMicros) / 1_000_000,
    purchases: num(r.metrics.conversions),
    purchase_value: num(r.metrics.conversionsValue),
  }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { since, until } = readRange(req.query);
    const view = ["monthly", "keywords"].includes(req.query.view) ? req.query.view : "campaigns";
    const key = `${view}_${since}_${until}`;
    let data = req.query.refresh === "1" ? null : cache.get(key);
    if (!data && view === "keywords") {
      data = { source: "google_ads", view, since, until, rows: await fetchKeywords(since, until), fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    if (!data && view === "monthly") {
      data = { source: "google_ads", view, since, until, rows: await fetchMonthly(since, until), fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    if (!data) {
      const { account, rows } = await fetchGoogleAds(since, until);
      data = { source: "google_ads", since, until, apiVersion: API_VERSION, accounts: [account], rows, fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, "Google Ads", err);
  }
}
