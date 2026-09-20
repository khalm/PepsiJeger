import { createClient } from '@supabase/supabase-js';

const rawUrl = process.env.SUPABASE_URL || 'https://kxyahkeooiyalrnknlhd.supabase.co';
const supabaseUrl = rawUrl
  .replace(/['"\r\n\t ]/g, '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/+$/, '');

const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseKey = rawKey.replace(/['"\r\n\t ]/g, '');

if (!supabaseKey) {
  console.error("Mangler SUPABASE_SERVICE_ROLE_KEY!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

interface KassalProduct {
  name: string;
  price?: number;
  current_price?: number;
  updated_at?: string;
  created_at?: string;
  store?: {
    name?: string;
  };
}

// Generell norsk ordgjenkjenner for alle typer varer
function matcherSoekeord(produktNavn: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  const p = produktNavn.toLowerCase();

  if (q.includes(' ')) {
    return p.includes(q);
  }

  const ordListe = p.split(/[\s,./\-_+()%0-9]+/).filter(Boolean);

  for (const ord of ordListe) {
    if (ord === q) return true;

    if (ord.endsWith(q) && ord.length >= q.length + 2) {
      if (q === 'ost' && ord === 'frokost') continue;
      return true;
    }

    if (ord.startsWith(q) && ord.length >= q.length + 2) {
      return true;
    }
  }

  return false;
}

// Sjekker om prisen er oppdatert i løpet av de siste 7 dagene
function erPrisFersk(datoStreng?: string): boolean {
  if (!datoStreng) return true; // Hvis dato mangler, slipper den gjennom under tvil
  const oppdatertDato = new Date(datoStreng).getTime();
  const naatid = Date.now();
  const sjuDagerIMs = 7 * 24 * 60 * 60 * 1000;
  
  return (naatid - oppdatertDato) <= sjuDagerIMs;
}

async function syncDeals() {
  console.log("Renser gamle tilbud fra databasen...");
  // Tømmer gamle tilbud så du kun har de ferskeste aktuelle tilbudene i appen
  const { error: deleteErr } = await supabase
    .from('deals')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');

  if (deleteErr) {
    console.warn("Kunne ikke slette gamle tilbud:", deleteErr.message);
  }

  console.log("Henter innstillinger fra databasen...");

  // 1. Hent godkjente butikkjeder
  const { data: chainsData } = await supabase
    .from('selected_chains')
    .select('chain_name')
    .eq('is_selected', true);

  const allowedChains = (chainsData && chainsData.length > 0)
    ? chainsData.map(c => c.chain_name.toUpperCase())
    : ['REMA 1000', 'KIWI', 'EXTRA', 'COOP PRIX', 'SPAR'];

  console.log("Valgte butikkjeder:", allowedChains);

  // 2. Hent overvåkede varer
  const { data: watched } = await supabase
    .from('watched_items')
    .select('query');

  const queries = (watched && watched.length > 0)
    ? [...new Set(watched.map(w => w.query.trim().toLowerCase()))]
    : ['pepsi max'];

  console.log("Søker etter tilbud på:", queries);

  const kassalToken = process.env.KASSAL_TOKEN;

  for (const query of queries) {
    console.log(`\nHenter produkter for: "${query}"...`);

    const response = await fetch(
      `https://kassal.app/api/v1/products?search=${encodeURIComponent(query)}&size=30`,
      {
        headers: kassalToken ? { "Authorization": `Bearer ${kassalToken}` } : {}
      }
    );

    if (!response.ok) {
      console.warn(`Feil fra Kassal for "${query}": ${response.statusText}`);
      continue;
    }

    const result = await response.json();
    const products: KassalProduct[] = result.data || [];

    for (const item of products) {
      const storeName = item.store?.name || 'Ukjent butikk';
      const storeNameUpper = storeName.toUpperCase();

      // SJEKK 1: Butikkfilter
      const isStoreAllowed = allowedChains.some(chain => storeNameUpper.includes(chain));
      if (!isStoreAllowed) continue;

      // SJEKK 2: Ordgrense / språksjekk
      if (!matcherSoekeord(item.name, query)) {
        continue;
      }

      // SJEKK 3: Ferskhetssjekk (kun priser bekreftet siste 7 dager)
      const sistOppdatert = item.updated_at || item.created_at;
      if (!erPrisFersk(sistOppdatert)) {
        console.log(`⏳ Forkaster utdatert pris (${sistOppdatert}): "${item.name}"`);
        continue;
      }

      const actualPrice = item.current_price ?? item.price ?? 0;

      let storeId: string | null = null;
      const { data: existingStore } = await supabase
        .from('stores')
        .select('id')
        .ilike('name', `%${storeName}%`)
        .limit(1)
        .maybeSingle();

      if (existingStore) {
        storeId = existingStore.id;
      } else {
        const { data: newStore } = await supabase
          .from('stores')
          .insert({ 
            name: storeName, 
            chain: storeName,
            location: 'POINT(0 0)'
          })
          .select('id')
          .single();

        if (newStore) storeId = newStore.id;
      }

      await supabase.from('deals').insert({
        store_id: storeId,
        product_name: item.name,
        price: actualPrice,
        valid_to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

      console.log(`✅ Aktuell pris lagret: "${item.name}" (${actualPrice} kr) - ${storeName}`);
    }
  }
}

async function main() {
  await syncDeals();
  console.log("\nTilbudssynkronisering fullført!");
}

main().catch(console.error);
