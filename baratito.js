// ============================================================================
// BARATITO — comparador de precios de MercadoLibre
// ============================================================================
//
// IMPORTANTE: desde abril de 2025 la API de búsqueda de MercadoLibre ya NO es
// pública — hace falta un access token de una app registrada. Este script
// usa un refresh_token guardado en Supabase (tabla baratito.config) para
// renovarlo solo en cada corrida, porque MercadoLibre rota el refresh_token
// cada vez que se usa.
//
// SETUP (una sola vez):
//
// 1. Copiá el bloque SQL de más abajo y corrélo en el SQL Editor de tu
//    proyecto de Supabase. Crea el schema "baratito" sin tocar tus otros
//    proyectos que comparten la misma base.
//
// 2. En Supabase: Settings → API. Copiá:
//      - la URL del proyecto
//      - la "service role key" (NO la anon key: esta necesita escribir sin
//        las restricciones de RLS, y nunca va en el frontend)
//
// 3. Registrá una app en developers.mercadolibre.com.ar (Mis aplicaciones →
//    Crear aplicación), autorizala una vez y conseguí un refresh_token
//    (ver la guía paso a paso que te dio Claude en el chat). Insertalo en
//    Supabase con:
//      insert into baratito.config (key, value)
//      values ('meli_refresh_token', 'TG-...');
//
// 4. En el repo de GitHub: Settings → Secrets and variables → Actions.
//    Cargá SUPABASE_URL, SUPABASE_SERVICE_KEY, MELI_CLIENT_ID y
//    MELI_CLIENT_SECRET (client_id/secret de la app de MercadoLibre;
//    el refresh_token NO va acá, ya quedó en Supabase).
//
// 5. Para correrlo en local:
//      npm install @supabase/supabase-js
//      SUPABASE_URL=... SUPABASE_SERVICE_KEY=... MELI_CLIENT_ID=... MELI_CLIENT_SECRET=... node baratito.js
//
// 6. El cron de .github/workflows/fetch-precios.yml lo corre solo cada
//    6 horas una vez pusheado (o lo disparás a mano desde la pestaña Actions).
//
// AGREGAR O SACAR PRODUCTOS:
//   Editá el objeto CONFIG de abajo. No hace falta redesplegar nada, el
//   próximo cron ya usa los cambios.
//   - "busquedas": compara todos los vendedores de ese término.
//     poné "activa: false" para pausar una sin borrarla.
//   - "itemIdsManuales": para seguir una publicación puntual (el ID sale
//     de la URL del producto en MercadoLibre, ej. "MLA123456789").
//
// CÓMO QUEDAN LOS DATOS:
//   baratito.busquedas  -> los términos que trackeás
//   baratito.productos  -> cada publicación de MELI encontrada (1 por vendedor)
//   baratito.snapshots  -> una fila por corrida del cron, con precio y
//                          sold_quantity de ese momento. Ahí vive el
//                          historial de precios y de ahí sale cualquier
//                          ranking de "más vendido" (comparando sold_quantity
//                          entre snapshots).
//
// ============================================================================
// MIGRACIÓN SQL (pegar una sola vez en el SQL Editor de Supabase)
// ============================================================================
/*
create schema if not exists baratito;

create table baratito.busquedas (
  id uuid primary key default gen_random_uuid(),
  termino text not null,
  categoria text,
  activa boolean default true,
  created_at timestamptz default now()
);

create table baratito.productos (
  id uuid primary key default gen_random_uuid(),
  meli_item_id text unique not null,
  busqueda_id uuid references baratito.busquedas(id) on delete set null,
  titulo text not null,
  permalink text,
  imagen_url text,
  seller_id text,
  seller_nickname text,
  created_at timestamptz default now()
);

create table baratito.snapshots (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid references baratito.productos(id) on delete cascade,
  precio numeric not null,
  precio_original numeric,
  moneda text default 'ARS',
  sold_quantity int,
  disponible boolean default true,
  captured_at timestamptz default now()
);

create index if not exists idx_snapshots_producto_fecha
  on baratito.snapshots (producto_id, captured_at desc);

create index if not exists idx_productos_busqueda
  on baratito.productos (busqueda_id);

-- Guarda el refresh_token vigente de MercadoLibre (se rota en cada uso)
create table baratito.config (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

alter table baratito.busquedas enable row level security;
alter table baratito.productos enable row level security;
alter table baratito.snapshots enable row level security;
alter table baratito.config enable row level security;

create policy "lectura publica busquedas" on baratito.busquedas
  for select using (true);
create policy "lectura publica productos" on baratito.productos
  for select using (true);
create policy "lectura publica snapshots" on baratito.snapshots
  for select using (true);
-- config NO lleva policy de lectura pública a propósito: el refresh_token
-- solo lo tiene que poder leer el service role (que bypassea RLS).

-- La escritura la hace únicamente el cron con la service role key,
-- que bypassea RLS por default, así que no hace falta policy de insert/update.

-- Exponer el schema a la API (Settings → Data API → Exposed schemas
-- también hay que agregar "baratito" a mano ahí, esto solo da los permisos):
grant usage on schema baratito to anon, authenticated;
grant select on all tables in schema baratito to anon, authenticated;
alter default privileges in schema baratito grant select on tables to anon, authenticated;
revoke select on baratito.config from anon, authenticated;
*/

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// ============================================================================
// CONFIG — acá se agregan o sacan productos a trackear
// ============================================================================
const CONFIG = {
  site: 'MLA',
  resultadosPorBusqueda: 30,
  busquedas: [
    { termino: 'filamento pla 1kg', categoria: 'filamentos', activa: true },
    { termino: 'filamento petg 1kg', categoria: 'filamentos', activa: true },
    { termino: 'filamento abs 1kg', categoria: 'filamentos', activa: true },
    { termino: 'filamento tpu 1kg', categoria: 'filamentos', activa: true },
  ],
  itemIdsManuales: [
    // 'MLA123456789',
  ],
};

// ============================================================================
// SCRIPT
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MELI_CLIENT_ID = process.env.MELI_CLIENT_ID;
const MELI_CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MELI_CLIENT_ID || !MELI_CLIENT_SECRET) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SERVICE_KEY, MELI_CLIENT_ID o MELI_CLIENT_SECRET en las env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: 'baratito' },
  realtime: { transport: ws }, // evita el error de WebSocket nativo en Node < 22; no usamos realtime igual
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Renueva el access_token usando el refresh_token guardado en Supabase,
// y guarda el refresh_token nuevo que MercadoLibre devuelve (lo rota siempre).
async function renovarAccessToken() {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'meli_refresh_token')
    .single();

  if (error || !data) {
    console.error('Detalle del error de Supabase:', JSON.stringify(error, null, 2));
    throw new Error('No hay meli_refresh_token guardado en baratito.config. Seguí la guía de autorización primero.');
  }

  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: MELI_CLIENT_ID,
      client_secret: MELI_CLIENT_SECRET,
      refresh_token: data.value,
    }),
  });

  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`No se pudo renovar el token de MercadoLibre (${res.status}): ${texto}`);
  }

  const tokenData = await res.json();

  const { error: updateError } = await supabase
    .from('config')
    .update({ value: tokenData.refresh_token, updated_at: new Date().toISOString() })
    .eq('key', 'meli_refresh_token');

  if (updateError) throw updateError;

  return tokenData.access_token;
}

async function getOrCreateBusqueda(termino, categoria) {
  const { data: existente, error: selectError } = await supabase
    .from('busquedas')
    .select('id')
    .eq('termino', termino)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existente) return existente.id;

  const { data: creada, error: insertError } = await supabase
    .from('busquedas')
    .insert({ termino, categoria })
    .select('id')
    .single();

  if (insertError) throw insertError;
  return creada.id;
}

async function upsertProducto({ meliItemId, busquedaId, titulo, permalink, imagenUrl, sellerId, sellerNickname }) {
  const { data, error } = await supabase
    .from('productos')
    .upsert(
      {
        meli_item_id: meliItemId,
        busqueda_id: busquedaId ?? null,
        titulo,
        permalink,
        imagen_url: imagenUrl,
        seller_id: sellerId ? String(sellerId) : null,
        seller_nickname: sellerNickname ?? null,
      },
      { onConflict: 'meli_item_id' }
    )
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function insertSnapshot(productoId, { precio, precioOriginal, moneda, soldQuantity, disponible }) {
  const { error } = await supabase.from('snapshots').insert({
    producto_id: productoId,
    precio,
    precio_original: precioOriginal ?? null,
    moneda: moneda ?? 'ARS',
    sold_quantity: soldQuantity ?? null,
    disponible: disponible ?? true,
  });

  if (error) throw error;
}

async function procesarBusqueda(site, { termino, categoria }, limit, accessToken) {
  console.log(`Buscando: "${termino}"`);
  const busquedaId = await getOrCreateBusqueda(termino, categoria);

  const url = `https://api.mercadolibre.com/sites/${site}/search?q=${encodeURIComponent(termino)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    console.error(`  Error ${res.status} buscando "${termino}"`);
    return;
  }

  const data = await res.json();
  const items = data.results ?? [];
  console.log(`  ${items.length} resultados`);

  for (const item of items) {
    try {
      const productoId = await upsertProducto({
        meliItemId: item.id,
        busquedaId,
        titulo: item.title,
        permalink: item.permalink,
        imagenUrl: item.thumbnail,
        sellerId: item.seller?.id,
        sellerNickname: item.seller?.nickname,
      });

      await insertSnapshot(productoId, {
        precio: item.price,
        precioOriginal: item.original_price,
        moneda: item.currency_id,
        soldQuantity: item.sold_quantity,
        disponible: (item.available_quantity ?? 1) > 0,
      });
    } catch (err) {
      console.error(`  Error guardando item ${item.id}:`, err.message);
    }
  }
}

async function procesarItemManual(itemId, accessToken) {
  console.log(`Item manual: ${itemId}`);
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    console.error(`  Error ${res.status} en item ${itemId}`);
    return;
  }

  const item = await res.json();

  try {
    const productoId = await upsertProducto({
      meliItemId: item.id,
      busquedaId: null,
      titulo: item.title,
      permalink: item.permalink,
      imagenUrl: item.thumbnail,
      sellerId: item.seller_id,
      sellerNickname: null,
    });

    await insertSnapshot(productoId, {
      precio: item.price,
      precioOriginal: item.original_price,
      moneda: item.currency_id,
      soldQuantity: item.sold_quantity,
      disponible: (item.available_quantity ?? 1) > 0,
    });
  } catch (err) {
    console.error(`  Error guardando item ${itemId}:`, err.message);
  }
}

async function main() {
  console.log('Renovando access token de MercadoLibre...');
  const accessToken = await renovarAccessToken();

  const busquedas = CONFIG.busquedas.filter((b) => b.activa !== false);

  for (const busqueda of busquedas) {
    await procesarBusqueda(CONFIG.site, busqueda, CONFIG.resultadosPorBusqueda, accessToken);
    await sleep(500); // respiro entre requests para no pegar contra el rate limit
  }

  for (const itemId of CONFIG.itemIdsManuales) {
    await procesarItemManual(itemId, accessToken);
    await sleep(300);
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
