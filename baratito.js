// ============================================================================
// BARATITO — comparador de precios de MercadoLibre
// ============================================================================
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
// 3. En el repo de GitHub: Settings → Secrets and variables → Actions.
//    Cargá SUPABASE_URL y SUPABASE_SERVICE_KEY con esos valores.
//
// 4. Para correrlo en local:
//      npm install @supabase/supabase-js
//      SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node baratito.js
//
// 5. El cron de .github/workflows/fetch-precios.yml lo corre solo cada
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

alter table baratito.busquedas enable row level security;
alter table baratito.productos enable row level security;
alter table baratito.snapshots enable row level security;

create policy "lectura publica busquedas" on baratito.busquedas
  for select using (true);
create policy "lectura publica productos" on baratito.productos
  for select using (true);
create policy "lectura publica snapshots" on baratito.snapshots
  for select using (true);

-- La escritura la hace únicamente el cron con la service role key,
-- que bypassea RLS por default, así que no hace falta policy de insert/update.
*/

import { createClient } from '@supabase/supabase-js';

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

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en las env vars.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: 'baratito' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function procesarBusqueda(site, { termino, categoria }, limit) {
  console.log(`Buscando: "${termino}"`);
  const busquedaId = await getOrCreateBusqueda(termino, categoria);

  const url = `https://api.mercadolibre.com/sites/${site}/search?q=${encodeURIComponent(termino)}&limit=${limit}`;
  const res = await fetch(url);

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

async function procesarItemManual(itemId) {
  console.log(`Item manual: ${itemId}`);
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`);

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
  const busquedas = CONFIG.busquedas.filter((b) => b.activa !== false);

  for (const busqueda of busquedas) {
    await procesarBusqueda(CONFIG.site, busqueda, CONFIG.resultadosPorBusqueda);
    await sleep(500); // respiro entre requests para no pegar contra el rate limit
  }

  for (const itemId of CONFIG.itemIdsManuales) {
    await procesarItemManual(itemId);
    await sleep(300);
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
