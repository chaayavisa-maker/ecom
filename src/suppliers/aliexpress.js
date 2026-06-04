async function searchProducts(query, options = {}) {
  const { minRating = 4.0, maxPrice = 20, limit = 20 } = options;

  if (!process.env.ALIEXPRESS_APP_KEY) {
    return _mockSearchResults(query, limit);
  }

  try {
    const response = await axios.get('https://api.aliexpress.com/v2/product/search', {
      params: {
        keywords:  query,
        sort:      'LAST_VOLUME_DESC',
        minPrice:  1,
        maxPrice,
        pageSize:  limit,
        appKey:    process.env.ALIEXPRESS_APP_KEY,
      },
      timeout: 15_000,
    });

    // ── FIX 1: try both response envelope keys ──────────────────────────────
    const root = response.data;
    const resultBlock =
      root?.aliexpress_affiliate_product_query_response?.resp_result?.result  // Affiliate API
      ?? root?.aliexpress_ds_product_search_get_response?.result              // DS API
      ?? null;

    if (!resultBlock) {
      // Log the actual envelope so you can see what key the API is really using
      const topKeys = Object.keys(root || {});
      logger.warn(`[AliExpress] Unexpected response shape for "${query}". Top-level keys: [${topKeys.join(', ')}]`);
      logger.debug(`[AliExpress] Raw response (truncated): ${JSON.stringify(root).slice(0, 600)}`);
      return [];
    }

    const items = resultBlock?.products?.product ?? [];
    logger.info(`[AliExpress] "${query}" → ${items.length} raw items from API`);

    if (items.length === 0) return [];

    // ── FIX 2: normalise evaluate_rate regardless of 0–5 or 0–100 scale ────
    const normaliseRating = (raw) => {
      const n = parseFloat(raw || '0');
      if (n === 0) return 0;
      return n > 10 ? n / 20 : n;   // >10 means 0–100 scale → convert to 0–5
    };

    const results = items
      .filter(p => {
        const rating = normaliseRating(p.evaluate_rate);
        return rating >= minRating;
      })
      .map(p => ({
        productId:   String(p.product_id),
        title:       p.product_title,
        price:       parseFloat(p.app_sale_price ?? p.sale_price ?? 0),
        cost:        parseFloat(p.app_sale_price ?? p.sale_price ?? 0),
        imageUrl:    normaliseImageUrl(p.product_main_image_url),
        productUrl:  p.product_detail_url,
        supplierUrl: p.product_detail_url,
        rating:      normaliseRating(p.evaluate_rate),
        totalOrders: parseInt(p.lastest_volume ?? p.orders ?? '0'),
        reviewCount: parseInt(p.evaluate_cnt ?? '0'),
      }));

    logger.info(`[AliExpress] "${query}" → ${results.length} products (after minRating ${minRating} filter)`);
    return results;

  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('[AliExpress] Rate limited — waiting 30s');
      await new Promise(r => setTimeout(r, 30_000));
    }
    // ── Log HTTP status + body for easier diagnosis ──────────────────────────
    if (err.response) {
      logger.error(`[AliExpress] HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`);
    }
    logger.error(`[AliExpress] searchProducts failed: ${err.message}`);
    return [];
  }
}
