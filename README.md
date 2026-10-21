# Dashboard Tiba Salud

Frontend estático (`index.html`) + funciones serverless de Vercel en `/api/`.
El navegador solo llama a `/api/...`; las credenciales viven en variables de entorno de Vercel.

Vista previa con datos de ejemplo: `https://<proyecto>.vercel.app/?demo=1`

## Endpoints

| Endpoint | Qué devuelve |
|---|---|
| `/api/shopify?info=1` | Zona horaria, moneda y si los precios incluyen IVA |
| `/api/shopify?since=&until=` | Pedidos válidos con venta neta, cliente nuevo/recurrente y productos |
| `/api/meta-ads?since=&until=` | Filas diarias por campaña (con `objective`) |
| `/api/meta-ads?view=audiences&since=&until=` | Totales por edad, género, dispositivo y plataforma |
| `/api/google-ads?since=&until=` | Filas diarias por campaña |

Todos aceptan `&refresh=1` para saltar la caché de 10 minutos.

## Variables de entorno

Shopify (app del Dev Dashboard; scopes `read_orders`, `read_products`, `read_customers`)
- `SHOPIFY_STORE_DOMAIN` — `xxx.myshopify.com`
- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_API_VERSION` — opcional, default `2026-07`
- `SHOPIFY_TAXES_INCLUDED` — opcional `true`/`false`; si no existe se usa `shop.taxesIncluded`

Meta Ads
- `META_ACCESS_TOKEN` — token de System User con `ads_read`
- `META_ACCOUNT_ID` — una cuenta; si se agregan más, separarlas por coma
- `META_API_VERSION` — opcional, default `v23.0`

Google Ads
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (solo vía MCC)
- `GOOGLE_ADS_API_VERSION` — opcional, default `v23`

General
- `BUSINESS_TZ` — opcional, default `America/Mexico_City` (solo para rangos por defecto en el backend; el dashboard usa la zona de la tienda)

Después de agregar o cambiar variables: **Redeploy**.

## Reglas de negocio

- Venta: pedido `PAID` o `PARTIALLY_REFUNDED`, no cancelado y no de prueba.
- Fecha: `createdAt` convertido a la fecha local de la tienda. Se pide un día extra de cada lado y se filtra localmente.
- Venta neta: `currentSubtotalPriceSet` (después de descuentos y devoluciones, sin envío). Si los precios incluyen IVA se resta el IVA de los productos: `currentTotalTaxSet` menos el IVA del envío.
- Cliente nuevo: el pedido es el primer pedido válido histórico del cliente. Los pedidos sin cliente cuentan como nuevos.
- ROAS blended = ventas netas ÷ inversión total (Meta + Google). CPA blended = inversión total ÷ pedidos.
- Tasa de recompra: clientes con 2 o más pedidos en el periodo ÷ clientes identificados del periodo.
- Meta: objetivo por `objective`. Etiqueta Retargeting por `CAMPAIGN_OVERRIDES` (en `index.html`) o si el nombre contiene "RTG" o "retargeting".

## Depurar desde la consola

`DATA`, `STATE`, `RAW_ORDERS`, `RAW_META_ROWS`, `RAW_GOOGLE_ROWS`, `RAW_AUDIENCES`.

## QA antes de entregar

Comparar ventas netas y pedidos contra un export de Shopify Analytics del mismo rango, e inversión contra Ads Manager y Google Ads.
