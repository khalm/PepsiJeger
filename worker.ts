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
  store?: {
    name?: string;
  };
}

// Generell norsk ordgjenkjenner for alle typer varer
function matcherSoekeord(produktNavn: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  const p = produktNavn.toLowerCase();

  // 1. Flerords-søk (f.eks. "pepsi max", "tine melk")
  if (q.includes(' ')) {
    return p.includes(q);
  }

  // 2. Del opp varenavnet i ord (fjerner tegn, prosent, bindestreker osv.)
  const ordListe = p.split(/[\s,./\-_+()%0-9]+/).filter(Boolean);

  for (const ord of ordListe) {
    // A. Eksakt ord (f.eks. "ost", "ris", "mel", "te")
    if (ord === q) return true;

    // B. Sammensatt ord med søkeordet bakerst (f.eks. "hvitost", "jasminris", "hvetemel")
    // For å unngå tilfeldige endelser (som f.eks. "frokost" på "ost")
    // krever vi at forstavelsen gir mening som sammensatt ord.
    if (ord.endsWith(q) && ord.length >= q.length + 2) {
      if (q === 'ost' && ord === 'frokost') continue; // kjent unntak i norsk ordstamme
      return true;
    }

    // C. Sammensatt ord med søkeordet foran (f.eks. "melkekartong", "tepose", "ostepop")
    if (ord.startsWith(q) && ord.length >= q.length + 2) {
      return true;
    }
  }

  return false;
}

async function syncDeals() {
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

      // Sjekk butikkjede
      const isStoreAllowed = allowedChains.some(chain => storeNameUpper.includes(chain));
      if (!isStoreAllowed) continue;

      // Sjekk ord-match
      if (!matcherSoekeord(item.name, query)) {
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

      console.log(`✅ Godkjent og lagret: "${item.name}" (${actualPrice} kr) - ${storeName}`);
    }
  }
}

async function main() {
  await syncDeals();
  console.log("\nTilbudssynkronisering fullført!");
}

main().catch(console.error);
