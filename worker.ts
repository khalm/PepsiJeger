import { createClient } from '@supabase/supabase-js';

// Renser URL for /rest/v1, skråstreker og anførselstegn
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

console.log(`Kobler til Supabase URL: ${supabaseUrl}`);

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

async function syncDeals() {
  console.log("Sjekker overvåkede varer i databasen...");

  const { data: watched, error: watchedErr } = await supabase
    .from('watched_items')
    .select('query');

  if (watchedErr) {
    console.error("Feil ved lesing av watched_items:", watchedErr.message);
  } else {
    console.log("watched_items lest OK!");
  }

  const queries = (watched && watched.length > 0)
    ? [...new Set(watched.map(w => w.query.trim().toLowerCase()))]
    : ['pepsi max'];

  console.log(`Søker etter tilbud på:`, queries);

  const kassalToken = process.env.KASSAL_TOKEN;

  for (const query of queries) {
    console.log(`Henter tilbud for: "${query}"...`);

    const response = await fetch(
      `https://kassal.app/api/v1/products?search=${encodeURIComponent(query)}&size=15`,
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
    console.log(`Fant ${products.length} produkter for "${query}".`);

    for (const item of products) {
      const storeName = item.store?.name || 'Ukjent butikk';
      const actualPrice = item.current_price ?? item.price ?? 0;

      let storeId: string | null = null;
      const { data: existingStore, error: findStoreErr } = await supabase
        .from('stores')
        .select('id')
        .ilike('name', `%${storeName}%`)
        .limit(1)
        .maybeSingle();

      if (findStoreErr) {
        console.error(`Feil ved søk etter butikk "${storeName}":`, findStoreErr.message);
      }

      if (existingStore) {
        storeId = existingStore.id;
      } else {
        const { data: newStore, error: storeErr } = await supabase
          .from('stores')
          .insert({ 
            name: storeName, 
            chain: storeName 
          })
          .select('id')
          .single();

        if (storeErr) {
          console.error(`Feil ved opprettelse av butikk "${storeName}":`, storeErr.message);
        } else if (newStore) {
          storeId = newStore.id;
        }
      }

      const { error: dealErr } = await supabase.from('deals').insert({
        store_id: storeId,
        product_name: item.name,
        price: actualPrice,
        valid_to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (dealErr) {
        console.error(`DATABASEFEIL ved lagring av "${item.name}":`, dealErr.message);
      } else {
        console.log(`Vellykket lagring: ${item.name} (${actualPrice} kr) - ${storeName}`);
      }
    }
  }
}

async function main() {
  await syncDeals();
  console.log("Tilbudssynkronisering fullført!");
}

main().catch(console.error);
