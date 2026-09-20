import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Mangler SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

interface KassalProduct {
  name: string;
  price: number;
  store?: {
    name?: string;
  };
}

async function syncDeals() {
  console.log("Sjekker overvåkede varer i databasen...");

  const { data: watched, error: watchedErr } = await supabase
    .from('watched_items')
    .select('query');

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

      // Finn butikk i databasen eller opprett den automatisk hvis den ikke finnes
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
          .insert({ name: storeName })
          .select('id')
          .single();
        if (newStore) storeId = newStore.id;
      }

      // Lagre tilbudet
      const { error: insertErr } = await supabase.from('deals').insert({
        store_id: storeId,
        product_name: item.name,
        price: item.price,
        store_name: storeName,
        valid_to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (insertErr) {
        // Hvis tabellen mangler kolonnen 'store_name', prøv uten den
        await supabase.from('deals').insert({
          store_id: storeId,
          product_name: item.name,
          price: item.price,
          valid_to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
      }

      console.log(`Lagret tilbud: ${item.name} (${item.price} kr) - ${storeName}`);
    }
  }
}

async function main() {
  await syncDeals();
  console.log("Tilbudssynkronisering fullført!");
}

main().catch(console.error);
