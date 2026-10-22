// GET /api/shopify?since=YYYY-MM-DD&until=YYYY-MM-DD[&refresh=1]
// GET /api/shopify?info=1   → zona horaria, moneda y si los precios incluyen IVA
//
// Shopify Admin GraphQL por REST (sin SDK). App creada en el Dev Dashboard;
// el token se obtiene con client credentials y dura ~24 h, así que se cachea
// y se renueva solo.
//
// Variables de entorno:
//   SHOPIFY_STORE_DOMAIN     xxx.myshopify.com
//   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
//   SHOPIFY_API_VERSION      opcional, default 2026-07
//   SHOPIFY_TAXES_INCLUDED   opcional "true"/"false"; si no se define se usa shop.taxesIncluded
//
// Reglas de negocio implementadas:
//   - Venta = pedido PAID o PARTIALLY_REFUNDED, no cancelado, no de prueba.
//   - Fecha = createdAt convertido a la fecha local de la tienda (shop.ianaTimezone).
//     Se piden un día extra de cada lado y se filtra aquí.
//   - Venta neta = currentSubtotalPriceSet (ya descuenta descuentos y devoluciones,
//     sin envío). Si los precios incluyen IVA, se resta el IVA de los productos
//     (IVA total del pedido menos el IVA del envío).
//   - Cliente nuevo = el pedido es el primer pedido válido histórico del cliente.

import { readRange, num, makeCache, sendError, addDays, localDate } from "./_lib/range.js";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
const SHOP = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const cache = makeCache(10 * 60 * 1000);
let tokenCache = { token: null, expiresAt: 0 };
let infoCache = null;

const VALID_STATUS = new Set(["PAID", "PARTIALLY_REFUNDED"]);
const isValidOrder = (o) => !o.test && !o.cancelledAt && VALID_STATUS.has(o.displayFinancialStatus);
const money = (set) => num(set?.shopMoney?.amount);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60_000) return tokenCache.token;
  if (!SHOP) throw new Error("Falta SHOPIFY_STORE_DOMAIN en las variables de entorno");
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID || "",
      client_secret: process.env.SHOPIFY_CLIENT_SECRET || "",
    }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok || !json.access_token) {
    throw new Error(`No se pudo obtener el token de Shopify (HTTP ${res.status}): ${json.error_description || json.error || json.errors || json.raw || "sin detalle"}`);
  }
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 86400) * 1000 };
  return tokenCache.token;
}

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  const throttled = res.status === 429 || (json.errors || []).some((e) => e.extensions?.code === "THROTTLED");
  if (throttled && attempt < 6) { await sleep(1000 * (attempt + 1)); return gql(query, variables, attempt + 1); }
  if (res.status === 401) tokenCache = { token: null, expiresAt: 0 };
  if (!res.ok || json.errors) {
    const msg = Array.isArray(json.errors) ? json.errors.map((e) => e.message).join(" | ") : json.errors || `HTTP ${res.status}`;
    throw new Error(`Shopify GraphQL: ${msg}`);
  }
  return json.data;
}

async function getShopInfo() {
  if (infoCache) return infoCache;
  const d = await gql(`{ shop { name ianaTimezone currencyCode taxesIncluded } }`);
  const env = process.env.SHOPIFY_TAXES_INCLUDED;
  infoCache = {
    name: d.shop.name,
    timezone: d.shop.ianaTimezone,
    currency: d.shop.currencyCode,
    taxesIncluded: env === "true" ? true : env === "false" ? false : !!d.shop.taxesIncluded,
    taxesIncludedSource: env === "true" || env === "false" ? "env" : "shop",
  };
  return infoCache;
}

// Costo de query: 20 pedidos × 25 productos se mantiene bajo el límite de 1000 puntos.
const ORDERS_QUERY = `
query Orders($q: String!, $after: String) {
  orders(first: 20, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt test cancelledAt displayFinancialStatus
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      shippingLines(first: 3) { nodes { taxLines { priceSet { shopMoney { amount } } } } }
      customer {
        id
        orders(first: 5, sortKey: CREATED_AT) {
          nodes { id test cancelledAt displayFinancialStatus }
        }
      }
      lineItems(first: 25) {
        nodes {
          title quantity currentQuantity
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
          taxLines { priceSet { shopMoney { amount } } }
          product { id title productType vendor }
        }
      }
    }
  }
}`;

function mapOrder(o, info) {
  const subtotal = money(o.currentSubtotalPriceSet);
  const totalTax = money(o.currentTotalTaxSet);
  const shippingTax = (o.shippingLines?.nodes || []).flatMap((s) => s.taxLines || []).reduce((a, t) => a + money(t.priceSet), 0);
  const itemsTax = Math.max(0, totalTax - shippingTax);
  const net = Math.max(0, info.taxesIncluded ? subtotal - itemsTax : subtotal);

  // Primer pedido válido del cliente (se revisan sus primeros 5 por fecha).
  const firstValid = (o.customer?.orders?.nodes || []).find(isValidOrder);
  const isNew = !o.customer ? true : firstValid ? firstValid.id === o.id : false;

  const items = (o.lineItems?.nodes || [])
    .filter((li) => (li.currentQuantity || 0) > 0)
    .map((li) => {
      const qty = li.currentQuantity;
      const gross = money(li.discountedUnitPriceAfterAllDiscountsSet) * qty;
      const tax = (li.taxLines || []).reduce((a, t) => a + money(t.priceSet), 0) * (li.quantity ? qty / li.quantity : 0);
      return {
        product_id: li.product?.id || `sin-producto:${li.title}`,
        title: (li.product?.title || li.title || "").trim(),
        // trim: en la tienda hay proveedores "Tiba Salud" y "Tiba Salud " (con espacio)
        type: (li.product?.productType || "").trim(),
        vendor: (li.product?.vendor || "").trim(),
        qty,
        net: Math.max(0, info.taxesIncluded ? gross - tax : gross),
      };
    });

  return {
    id: o.id,
    name: o.name,
    date: localDate(o.createdAt, info.timezone),
    created_at: o.createdAt,
    financial_status: o.displayFinancialStatus,
    customer_id: o.customer?.id || null,
    is_new: isNew,
    subtotal,
    items_tax: itemsTax,
    net,
    items,
  };
}

async function fetchOrders(since, until, info) {
  // Un día de margen de cada lado; el filtro real se hace con la fecha local.
  const q = `created_at:>=${addDays(since, -1)} created_at:<${addDays(until, 2)} -status:cancelled`;
  const out = [];
  let after = null;
  let excluded = { test: 0, cancelled: 0, financial_status: 0, out_of_range: 0 };
  do {
    const d = await gql(ORDERS_QUERY, { q, after });
    for (const o of d.orders.nodes) {
      if (o.test) { excluded.test++; continue; }
      if (o.cancelledAt) { excluded.cancelled++; continue; }
      if (!VALID_STATUS.has(o.displayFinancialStatus)) { excluded.financial_status++; continue; }
      const m = mapOrder(o, info);
      if (m.date < since || m.date > until) { excluded.out_of_range++; continue; }
      out.push(m);
    }
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  return { orders: out, excluded };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const info = await getShopInfo();
    if (req.query.info === "1") {
      res.setHeader("Cache-Control", "s-maxage=3600");
      return res.status(200).json({ source: "shopify", shop: info });
    }
    const { since, until } = readRange(req.query);
    const key = `${since}_${until}`;
    let data = req.query.refresh === "1" ? null : cache.get(key);
    if (!data) {
      const { orders, excluded } = await fetchOrders(since, until, info);
      data = { source: "shopify", since, until, apiVersion: API_VERSION, shop: info, orders, excluded, fetchedAt: new Date().toISOString() };
      cache.set(key, data);
    }
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, "Shopify", err);
  }
}
