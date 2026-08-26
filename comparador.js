// ============================================================================
// COMPARADOR DE PROVEEDORES — bicicletería (reutiliza el proyecto Baratito)
// ============================================================================
//
// Este reemplaza por completo la parte de MercadoLibre. Ya no hace falta
// ningún token ni OAuth: los sitios de los proveedores son públicos.
//
// SETUP (una sola vez):
//
// 1. Corré la migración SQL de abajo en el SQL Editor de Supabase. Borra
//    todo lo viejo de MercadoLibre (búsquedas, productos, snapshots, config)
//    y crea las tablas nuevas: proveedores, productos, snapshots.
//
// 2. En GitHub, los secrets que quedan son solo dos (podés borrar
//    MELI_CLIENT_ID y MELI_CLIENT_SECRET si querés, ya no se usan):
//      SUPABASE_URL
//      SUPABASE_SERVICE_KEY
//
// 3. Para correrlo en local:
//      npm install @supabase/supabase-js ws cheerio
//      SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node comparador.js
//
// AGREGAR O SACAR PROVEEDORES O PÁGINAS (ya no se edita este archivo):
//   Todo vive en Supabase ahora, en las tablas "proveedores" y "paginas".
//   Para agregar un proveedor nuevo:
//     insert into baratito.proveedores (nombre, url_base, rubro)
//     values ('Nombre del negocio', 'https://sitio.com', 'bicicleteria');
//   Y una fila en "paginas" por cada URL de categoría/listado que quieras
//   que recorra (usando el id que te devolvió el insert anterior):
//     insert into baratito.paginas (proveedor_id, url)
//     values ('el-id-que-devolvio-el-insert', 'https://sitio.com/categoria');
//   Para pausar un proveedor o una página sin borrarla, poné activo = false.
//
// CÓMO DETECTA LOS PRODUCTOS (para entender si falla en algún sitio nuevo):
//   No usa una plantilla fija por sitio. Busca cada link de la página, mira
//   si su "contenedor" cercano tiene un precio en formato $ X.XXX,XX, y si lo
//   tiene, lo toma como producto. Esto funciona en la mayoría de las tiendas
//   (Tiendanube, Magento, WooCommerce, etc.) sin tener que armar un lector
//   distinto para cada una, pero puede fallar en sitios con diseños raros —
//   si un proveedor nuevo da 0 resultados, avisale a Claude para ajustarlo.
//
// ============================================================================
// MIGRACIÓN SQL (pegar una sola vez en el SQL Editor de Supabase)
// ============================================================================
/*
-- Limpieza de todo lo de MercadoLibre
drop table if exists baratito.snapshots cascade;
drop table if exists baratito.productos cascade;
drop table if exists baratito.busquedas cascade;
drop table if exists baratito.config cascade;

create table baratito.proveedores (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  url_base text not null,
  rubro text default 'bicicleteria',
  activo boolean default true,
  created_at timestamptz default now()
);

create table baratito.productos (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid references baratito.proveedores(id) on delete cascade,
  titulo text not null,
  url text unique not null,
  imagen_url text,
  created_at timestamptz default now()
);

-- Páginas de listado (categorías, inicio, etc.) que el cron recorre por cada proveedor.
-- Antes esto vivía hardcodeado en comparador.js; ahora se administra acá,
-- así agregar un proveedor nuevo no requiere tocar código ni GitHub.
create table baratito.paginas (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid references baratito.proveedores(id) on delete cascade,
  url text not null,
  activo boolean default true,
  created_at timestamptz default now()
);

create table baratito.snapshots (
  id uuid primary key default gen_random_uuid(),
  producto_id uuid references baratito.productos(id) on delete cascade,
  precio numeric not null,
  precio_efectivo numeric,
  captured_at timestamptz default now()
);

create index if not exists idx_snapshots_producto_fecha
  on baratito.snapshots (producto_id, captured_at desc);

create index if not exists idx_productos_proveedor
  on baratito.productos (proveedor_id);

alter table baratito.proveedores enable row level security;
alter table baratito.productos enable row level security;
alter table baratito.snapshots enable row level security;
alter table baratito.paginas enable row level security;

create policy "lectura publica proveedores" on baratito.proveedores
  for select using (true);
create policy "lectura publica productos" on baratito.productos
  for select using (true);
create policy "lectura publica snapshots" on baratito.snapshots
  for select using (true);
create policy "lectura publica paginas" on baratito.paginas
  for select using (true);

grant usage on schema baratito to anon, authenticated, service_role;
grant select on all tables in schema baratito to anon, authenticated;
grant all on all tables in schema baratito to service_role;
alter default privileges in schema baratito grant select on tables to anon, authenticated;
alter default privileges in schema baratito grant all on tables to service_role;

-- Sembrado: los 3 proveedores y páginas que ya veníamos usando hardcodeados
insert into baratito.proveedores (nombre, url_base, rubro)
select v.nombre, v.url_base, v.rubro
from (values
  ('Marcovecchio Bikes', 'https://marcovecchiobikes.com', 'bicicleteria'),
  ('Popeye ProBike', 'https://popeyeprobike.com.ar', 'bicicleteria'),
  ('Sin-Limite', 'https://sin-limite.com.ar', 'bicicleteria')
) as v(nombre, url_base, rubro)
where not exists (select 1 from baratito.proveedores p where p.nombre = v.nombre);

insert into baratito.paginas (proveedor_id, url)
select p.id, d.pagina from (
  values
    ('Marcovecchio Bikes', 'https://marcovecchiobikes.com/bicicletas'),
    ('Marcovecchio Bikes', 'https://marcovecchiobikes.com/componentes'),
    ('Popeye ProBike', 'https://popeyeprobike.com.ar/bicicletas/'),
    ('Sin-Limite', 'https://sin-limite.com.ar/')
) as d(nombre, pagina)
join baratito.proveedores p on p.nombre = d.nombre
where not exists (
  select 1 from baratito.paginas pg where pg.proveedor_id = p.id and pg.url = d.pagina
);
*/

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import * as cheerio from 'cheerio';

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
  realtime: { transport: ws },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrecio(texto) {
  // "$ 1.234.567,89" -> 1234567.89
  return parseFloat(texto.replace(/\./g, '').replace(',', '.'));
}

// Extrae productos de una página de listado sin depender de la plantilla del sitio:
// busca cada link, y si el contenedor cercano tiene un precio, lo toma como producto.
function extraerProductos(html, urlBase) {
  const $ = cheerio.load(html);
  $('script, style').remove(); // su texto interno no debe colarse como título ni precio
  // noscript suele traer la URL real de la imagen (fallback de lazy-loading),
  // así que en vez de borrarlo lo "desenvolvemos" para poder leerla.
  $('noscript').each((_, el) => {
    $(el).replaceWith($(el).html() || '');
  });
  const vistos = new Set();
  const productos = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    let url;
    try {
      url = new URL(href, urlBase).toString();
    } catch {
      return;
    }
    if (vistos.has(url)) return;

    // Subir hasta 4 niveles buscando un contenedor que tenga un precio
    let nodo = $(el);
    let contenedor = null;
    for (let i = 0; i < 4; i++) {
      nodo = nodo.parent();
      if (nodo.length === 0) break;
      const texto = nodo.text();
      if (/\$\s?[\d.]+,\d{2}/.test(texto)) {
        contenedor = nodo;
        break;
      }
    }
    if (!contenedor) return;

    const textoContenedor = contenedor.text().replace(/\s+/g, ' ').trim();
    const precios = [...textoContenedor.matchAll(/\$\s?([\d.]+,\d{2})/g)]
      .map((m) => parsePrecio(m[1]))
      .filter((p) => p > 0);

    if (precios.length === 0) return;

    let titulo = $(el).text().replace(/\s+/g, ' ').trim();
    if (!titulo || titulo.length < 4) {
      titulo = contenedor.find('h1,h2,h3,h4,strong,b').first().text().replace(/\s+/g, ' ').trim();
    }
    if (!titulo || titulo.length < 4) return;

    // Buscar imagen. Muchas veces está fuera del contenedor donde se encontró
    // el precio, así que si no aparece ahí, seguimos subiendo un poco más.
    let nodoImg = contenedor;
    let imgEl = nodoImg.find('img').first();
    let intentosImg = 0;
    while (imgEl.length === 0 && intentosImg < 4) {
      nodoImg = nodoImg.parent();
      if (nodoImg.length === 0) break;
      imgEl = nodoImg.find('img').first();
      intentosImg++;
    }

    let imagenUrl = null;
    if (imgEl.length) {
      const candidato =
        imgEl.attr('data-src') ||
        imgEl.attr('data-original') ||
        imgEl.attr('data-lazy') ||
        imgEl.attr('data-lazy-src') ||
        imgEl.attr('data-echo') ||
        (imgEl.attr('data-srcset') || '').split(',')[0]?.trim().split(' ')[0] ||
        (imgEl.attr('srcset') || '').split(',')[0]?.trim().split(' ')[0] ||
        imgEl.attr('src');
      if (candidato && !candidato.startsWith('data:')) {
        try {
          imagenUrl = new URL(candidato, urlBase).toString();
        } catch {
          imagenUrl = null;
        }
      }
    }

    vistos.add(url);
    productos.push({
      titulo,
      url,
      imagen_url: imagenUrl,
      precio: Math.max(...precios),          // precio de lista/tarjeta (el más alto)
      precio_efectivo: Math.min(...precios), // precio contado/transferencia (el más bajo)
    });
  });

  return productos;
}

async function upsertProducto(proveedorId, titulo, url, imagenUrl) {
  const { data, error } = await supabase
    .from('productos')
    .upsert(
      { proveedor_id: proveedorId, titulo, url, imagen_url: imagenUrl },
      { onConflict: 'url' }
    )
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function insertSnapshot(productoId, precio, precioEfectivo) {
  const { error } = await supabase.from('snapshots').insert({
    producto_id: productoId,
    precio,
    precio_efectivo: precioEfectivo,
  });
  if (error) throw error;
}

async function procesarPagina(proveedorId, url) {
  console.log(`  Página: ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ComparadorPrecios/1.0)' },
  });

  if (!res.ok) {
    console.error(`    Error ${res.status} obteniendo la página`);
    return;
  }

  const html = await res.text();
  const productos = extraerProductos(html, url);
  console.log(`    ${productos.length} productos encontrados`);

  for (const p of productos) {
    try {
      const productoId = await upsertProducto(proveedorId, p.titulo, p.url, p.imagen_url);
      await insertSnapshot(productoId, p.precio, p.precio_efectivo);
    } catch (err) {
      console.error(`    Error guardando "${p.titulo}":`, err.message);
    }
  }
}

async function main() {
  const { data: proveedores, error } = await supabase
    .from('proveedores')
    .select('id, nombre, paginas(id, url, activo)')
    .eq('activo', true);

  if (error) throw error;

  if (!proveedores || proveedores.length === 0) {
    console.log('No hay proveedores activos en la base. Agregá uno en la tabla baratito.proveedores.');
    return;
  }

  for (const proveedor of proveedores) {
    const paginasActivas = (proveedor.paginas || []).filter((p) => p.activo !== false);
    console.log(`Proveedor: ${proveedor.nombre} (${paginasActivas.length} página/s)`);

    for (const pagina of paginasActivas) {
      await procesarPagina(proveedor.id, pagina.url);
      await sleep(1000); // respiro entre páginas, buena práctica con cualquier sitio
    }
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
