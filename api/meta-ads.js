// GET /api/meta-ads?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1]
//   → filas diarias por campaña (con objective), sin agregar.
// GET /api/meta-ads?view=monthly&since=...&until=...   → inversión por mes
// GET /api/meta-ads?view=ads&since=...&until=...       → rendimiento por anuncio con miniatura
// GET /api/meta-ads?view=audiences&since=...&until=...
//   → totales del rango por edad, género, dispositivo y plataforma.
//
// Variables de entorno:
//   META_ACCESS_TOKEN   token de System User con ads_read
//   META_ACCOUNT_ID     ID de la cuenta (con o sin "act_"). Hoy es una sola;
//                       si se agrega otra, separarlas por coma: el código
//                       ya recorre el arreglo y concatena las filas.
//   META_API_VERSION    opcional, default v23.0

import { readRange, num, makeCache, sendError } from "./_lib/range.js";

const API_VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const cache = makeCache(10 * 60 * 1000);

// Meta reporta la misma compra bajo varios action_type. Se toma SOLO el primero
// que exista según este orden, para no contar dos veces la misma conversión.
const ACTION_PRIORITY = {
  purchases: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  checkouts: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
  add_to_cart: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  landing_page_views: ["landing_page_view"],
};

function pickAction(list, types) {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

function accountIds() {
  const raw = process.env.META_ACCOUNT_ID || "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).map((id) => (id.startsWith("act_") ? id : `act_${id}`));
  if (!ids.length) throw new Error("Falta META_ACCOUNT_ID en las variables de entorno");
  return ids;
}

async function metaGet(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(
      [e.message, e.error_user_msg, e.code && `code ${e.code}`, e.error_subcode && `subcode ${e.error_subcode}`, e.fbtrace_id && `trace ${e.fbtrace_id}`]
        .filter(Boolean)
        .join(" | ") || `HTTP ${res.status}`
    );
  }
  return json;
}

async function fetchAccount(accountId, since, until, token) {
  const info = await metaGet(
    `${BASE}/${accountId}?fields=name,currency,timezone_name&access_token=${encodeURIComponent(token)}`
  );

  const params = new URLSearchParams({
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "campaign_id,campaign_name,objective,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values",
    use_unified_attribution_setting: "true", // mismas cifras que Ads Manager
    limit: "500",
    access_token: token,
  });

  const rows = [];
  let url = `${BASE}/${accountId}/insights?${params}`;
  while (url) {
    const json = await metaGet(url);
    for (const r of json.data || []) {
      rows.push({
        date: r.date_start,
        account_id: accountId,
        account_name: info.name,
        campaign_id: r.campaign_id,
        campaign: r.campaign_name,
        objective: r.objective,
        spend: num(r.spend),
        impressions: num(r.impressions),
        reach: num(r.reach),
        clicks: num(r.clicks),
        link_clicks: num(r.inline_link_clicks),
        landing_page_views: pickAction(r.actions, ACTION_PRIORITY.landing_page_views),
        add_to_cart: pickAction(r.actions, ACTION_PRIORITY.add_to_cart),
        checkouts: pickAction(r.actions, ACTION_PRIORITY.checkouts),
        purchases: pickAction(r.actions, ACTION_PRIORITY.purchases),
        purchase_value: pickAction(r.action_values, ACTION_PRIORITY.purchases),
      });
    }
    url = json.paging?.next || null;
  }

  return {
    account: { id: accountId, name: info.name, currency: info.currency, timezone: info.timezone_name },
    rows,
  };
}

// Desglose mensual a nivel cuenta (para la gráfica Ene → hoy del Resumen).
async function fetchMonthly(since, until, token) {
  const rows = [];
  for (const id of accountIds()) {
    const params = new URLSearchParams({
      level: "account", time_increment: "monthly", time_range: JSON.stringify({ since, until }),
      fields: "spend,actions,action_values", use_unified_attribution_setting: "true", limit: "100", access_token: token,
    });
    let url = `${BASE}/${id}/insights?${params}`;
    while (url) {
      const json = await metaGet(url);
      for (const r of json.data || []) rows.push({ month: r.date_start.slice(0, 7), account_id: id, spend: num(r.spend), purchases: pickAction(r.actions, ACTION_PRIORITY.purchases), purchase_value: pickAction(r.action_values, ACTION_PRIORITY.purchases) });
      url = json.paging?.next || null;
    }
  }
  return { source: "meta", view: "monthly", since, until, rows, fetchedAt: new Date().toISOString() };
}

const CREATIVE_FIELDS = "creative{thumbnail_url,image_url,object_type}";
// Mismo campo pidiendo una miniatura de 240 px (la de 64 px por defecto se ve borrosa)
const CREATIVE_FIELDS_HD = "creative.thumbnail_width(240).thumbnail_height(240){thumbnail_url,image_url,object_type}";
function readCreative(ad) {
  const c = ad?.creative || {};
  // En imágenes se usa la original (nítida); en videos y carruseles, la portada.
  return { thumbnail: c.image_url || c.thumbnail_url || null, image: c.image_url || c.thumbnail_url || null, type: c.object_type || null };
}
async function fetchThumbnails(ids, token) {
  const thumbs = {};
  let error = null;
  const q = (fields) => `fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const json = await metaGet(`${BASE}/?ids=${chunk.join(",")}&${q(CREATIVE_FIELDS_HD)}`);
      for (const [adId, ad] of Object.entries(json)) thumbs[adId] = readCreative(ad);
    } catch (err) {
      error = err.message;
      // Respaldo: uno por uno, 6 a la vez; un anuncio que falle no afecta a los demás.
      for (let j = 0; j < chunk.length; j += 6) {
        await Promise.all(chunk.slice(j, j + 6).map(async (adId) => {
          try { thumbs[adId] = readCreative(await metaGet(`${BASE}/${adId}?${q(CREATIVE_FIELDS)}`)); }
          catch (e) { error = e.message; }
        }));
      }
    }
  }
  const found = Object.values(thumbs).filter((t) => t.thumbnail).length;
  return { thumbs, error: found ? null : error };
}

// Creativos: totales del rango por anuncio (sin time_increment, porque el alcance
// y la frecuencia no se pueden sumar día por día) + miniatura del creativo.
async function fetchAds(since, until, token) {
  const rows = [];
  for (const id of accountIds()) {
    const params = new URLSearchParams({
      level: "ad",
      time_range: JSON.stringify({ since, until }),
      fields: [
        "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name", "objective",
        "spend", "reach", "impressions", "frequency", "inline_link_clicks",
        "unique_inline_link_clicks", "unique_inline_link_click_ctr", "actions", "action_values",
      ].join(","),
      use_unified_attribution_setting: "true",
      limit: "500",
      access_token: token,
    });
    let url = `${BASE}/${id}/insights?${params}`;
    while (url) {
      const json = await metaGet(url);
      for (const r of json.data || []) {
        rows.push({
          ad_id: r.ad_id, ad: r.ad_name, adset_id: r.adset_id, adset: r.adset_name, campaign_id: r.campaign_id, campaign: r.campaign_name,
          objective: r.objective, account_id: id,
          spend: num(r.spend), reach: num(r.reach), impressions: num(r.impressions), frequency: num(r.frequency),
          link_clicks: num(r.inline_link_clicks), unique_link_clicks: num(r.unique_inline_link_clicks),
          unique_ctr: num(r.unique_inline_link_click_ctr) / 100,   // Meta lo entrega en porcentaje
          landing_page_views: pickAction(r.actions, ACTION_PRIORITY.landing_page_views),
          add_to_cart: pickAction(r.actions, ACTION_PRIORITY.add_to_cart),
          checkouts: pickAction(r.actions, ACTION_PRIORITY.checkouts),
          purchases: pickAction(r.actions, ACTION_PRIORITY.purchases),
          purchase_value: pickAction(r.action_values, ACTION_PRIORITY.purchases),
        });
      }
      url = json.paging?.next || null;
    }
  }

  // Miniaturas. Meta rechaza un lote completo si uno de los anuncios ya no existe o no es
  // accesible, así que se intenta en lote y, si falla, anuncio por anuncio.
  const ids = [...new Set(rows.map((r) => r.ad_id))];
  const { thumbs, error: thumbsError } = await fetchThumbnails(ids, token);
  for (const r of rows) Object.assign(r, thumbs[r.ad_id] || { thumbnail: null, image: null, type: null });
  return { source: "meta", view: "ads", since, until, rows, thumbsError, fetchedAt: new Date().toISOString() };
}

// Audiencias: una llamada por breakdown, a nivel cuenta, totales del rango.
const BREAKDOWNS = ["age", "gender", "device_platform", "publisher_platform"];

async function fetchBreakdown(accountId, breakdown, since, until, token) {
  const params = new URLSearchParams({
    level: "account",
    breakdowns: breakdown,
    time_range: JSON.stringify({ since, until }),
    fields: "spend,impressions,inline_link_clicks,actions,action_values",
    use_unified_attribution_setting: "true",
    limit: "500",
    access_token: token,
  });
  const rows = [];
  let url = `${BASE}/${accountId}/insights?${params}`;
  while (url) {
    const json = await metaGet(url);
    for (const r of json.data || []) {
      rows.push({
        breakdown,
        key: r[breakdown] ?? "unknown",
        account_id: accountId,
        spend: num(r.spend),
        impressions: num(r.impressions),
        link_clicks: num(r.inline_link_clicks),
        purchases: pickAction(r.actions, ACTION_PRIORITY.purchases),
        purchase_value: pickAction(r.action_values, ACTION_PRIORITY.purchases),
      });
    }
    url = json.paging?.next || null;
  }
  return rows;
}

async function fetchAudiences(since, until, token) {
  const ids = accountIds();
  const jobs = ids.flatMap((id) => BREAKDOWNS.map((b) => fetchBreakdown(id, b, since, until, token)));
  const results = await Promise.all(jobs);
  return { source: "meta", view: "audiences", since, until, apiVersion: API_VERSION, rows: results.flat(), fetchedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) throw new Error("Falta META_ACCESS_TOKEN en las variables de entorno");
    const { since, until } = readRange(req.query);
    const view = ["audiences", "monthly", "ads"].includes(req.query.view) ? req.query.view : "campaigns";
    const key = `${view}_${since}_${until}`;

    let data = req.query.refresh === "1" ? null : cache.get(key);
    if (!data && view === "ads") {
      data = await fetchAds(since, until, token);
      cache.set(key, data);
    }
    if (!data && view === "monthly") {
      data = await fetchMonthly(since, until, token);
      cache.set(key, data);
    }
    if (!data && view === "audiences") {
      data = await fetchAudiences(since, until, token);
      cache.set(key, data);
    }
    if (!data) {
      // Cada cuenta se consulta por separado y sus filas se concatenan (nunca
      // se sobreescriben): el bug del Map.set() de proyectos anteriores.
      const results = await Promise.all(accountIds().map((id) => fetchAccount(id, since, until, token)));
      data = {
        source: "meta",
        since,
        until,
        apiVersion: API_VERSION,
        accounts: results.map((r) => r.account),
        rows: results.flatMap((r) => r.rows),
        fetchedAt: new Date().toISOString(),
      };
      cache.set(key, data);
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, "Meta Ads", err);
  }
}
