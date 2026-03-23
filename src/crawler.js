// crawler-optimized.js
const Repository = require('./repository');
const path = require('path');
const { chromium } = require('playwright');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEFAULT_IDS = [
    '380919', '810289', '1596461', '1596467', '1596475',
    '1596803', '1635513', '1708740', '1711623', '1716962'
];

const PLATFORMS = {
    PRINTERVAL: 'printerval.com',
    MEEAR: 'meear.com'
};

// ============================================================
// OPTIMIZED CONFIG
// ============================================================
const CONFIG = {
    CONCURRENCY: 3,            // ✅ Giảm xuống 3 để ổn định hơn
    PAGE_TIMEOUT: 60000,       // ✅ Tăng lên 60s
    WAIT_AFTER_LOAD: 2000,     
    RETRY_DELAY: 2000,         
    RETRY_COUNT: 1,            // ✅ Giảm retry xuống 1 lần
    STAGGER_DELAY: 200,        
    DB_BATCH_SIZE: 5,          
    USE_BROWSER_POOL: true,    
};

/**
 * Crawl product - Optimized version
 */
async function crawlProduct(page, productId, platform, retryCount = CONFIG.RETRY_COUNT) {
    const redirectUrl = `https://${platform}/s-p${productId}`;
    let lastError = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
            // ✅ Sử dụng 'domcontentloaded' để nhanh hơn, retry dùng 'commit' để bypass challenge
            const waitStrategy = attempt === 0 ? 'domcontentloaded' : 'commit';
            
            const response = await page.goto(redirectUrl, {
                waitUntil: waitStrategy,
                timeout: CONFIG.PAGE_TIMEOUT
            });

            // ✅ Giảm wait time
            await page.waitForTimeout(CONFIG.WAIT_AFTER_LOAD);

            const finalUrl = page.url();
            const statusCode = response ? response.status() : 0;

            // ✅ Optimize: Chỉ lấy HTML khi cần check bot detection
            let needsHtmlCheck = statusCode === 403 || statusCode === 503;
            let html = '';
            if (needsHtmlCheck) {
                html = await page.content();
            }

            // ✅ Combine all page.evaluate calls into ONE
            const pageData = await page.evaluate(() => {
                const canonicalLink = document.querySelector('link[rel="canonical"]');
                const hasCustomContainer = !!document.querySelector('.customization-content-container');
                const hasCustomOption = !!document.querySelector('.customization-option-item');
                const hasPreviewBtn = !!document.querySelector('.btn-preview-persion');
                const hasVariantBox = !!document.querySelector('.product-variant-box');
                const hasAddToCartWrapper = !!document.querySelector('.addtocart-action-wrapper');

                return {
                    canonicalUrl: canonicalLink ? canonicalLink.href : null,
                    isCustom: hasCustomContainer || hasCustomOption || hasPreviewBtn,
                    isVariant: hasVariantBox || hasAddToCartWrapper
                };
            });

            const verifiedFinalUrl = (finalUrl.includes('-p') || (pageData.canonicalUrl && pageData.canonicalUrl.includes('-p')))
                ? (pageData.canonicalUrl || finalUrl)
                : finalUrl;

            // ✅ Kiểm tra nếu bị redirect về trang chủ hoặc URL không chứa mã sản phẩm (-p)
            // Tuy nhiên chỉ check nếu không phải 404
            const isProductPage = verifiedFinalUrl.includes('-p');
            if (statusCode === 200 && !isProductPage) {
                console.warn(`  ⚠️ [${productId}] Redirected to ${verifiedFinalUrl} (not a product page). Retrying...`);
                throw new Error('Redirected to non-product page (likely home page or bot-blocked)');
            }

            let customizable = false;
            let note = '';

            if (pageData.isCustom) {
                customizable = true;
                note = 'Có thể custom trực tiếp';
            } else if (pageData.isVariant) {
                customizable = false;
                note = 'Sản phẩm variant thông thường';
            } else {
                note = 'Không tìm thấy marker';
            }

            if (needsHtmlCheck && (html.includes('Cloudflare') || html.includes('bot detection'))) {
                note = 'Cảnh báo: Bot Protection';
            }

            const productData = {
                product_id: productId,
                platform: platform,
                redirect_url: redirectUrl,
                final_url: verifiedFinalUrl,
                customizable: customizable,
                note: note,
                status_code: statusCode,
                has_error: statusCode >= 400 && statusCode < 500 && statusCode !== 404,
                checked_at: new Date().toISOString()
            };

            return { success: true, data: productData };

        } catch (error) {
            lastError = error.message;
            console.error(`  ❌ Attempt ${attempt + 1} failed for ${productId}: ${lastError}`);

            if (attempt < retryCount) {
                // ✅ Thêm jitter để tránh dồn dập
                const jitter = Math.floor(Math.random() * 1000);
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY + jitter));
            }
        }
    }

    return {
        success: false,
        error: lastError,
        data: {
            product_id: productId,
            platform: platform,
            redirect_url: redirectUrl,
            final_url: '',
            customizable: false,
            note: `Error: ${lastError}`,
            status_code: 0,
            has_error: true,
            checked_at: new Date().toISOString()
        }
    };
}

/**
 * ✅ OPTIMIZED: Main crawler với multiple improvements
 */
async function runCrawlerOptimized(ids = DEFAULT_IDS, platform = PLATFORMS.PRINTERVAL, onProgress = null) {
    console.log(`🚀 Starting OPTIMIZED Crawler: ${ids.length} products, ${CONFIG.CONCURRENCY} workers`);

    // ✅ Deduplicate input IDs
    const uniqueIds = [...new Set(ids)];

    const results = {
        total: uniqueIds.length,
        success: 0,
        error: 0,
        data: []
    };

    const startTime = Date.now();
    let browser = null;
    const queue = [...uniqueIds];
    const processedIds = new Set(); // Track IDs handled in this session
    let count = 0;

    // ✅ Batch buffer for DB writes
    let dbBatchBuffer = [];

    try {
        // ✅ Launch browser với args tối ưu
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true
        });

        // ✅ Worker function với batch DB writes
        const worker = async (workerId) => {
            const page = await context.newPage();

            // Disable unnecessary resources to speed up
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            try {
                while (queue.length > 0) {
                    const id = queue.shift();
                    if (!id) break;

                    const currentCount = ++count;
                    console.log(`[Worker ${workerId}] Checking ${id} (${currentCount}/${uniqueIds.length})`);

                    // ✅ Check if already processed in this session (race condition protection)
                    if (processedIds.has(id)) {
                        console.log(` ⏩ [${workerId}] Skip duplicate in queue: ${id}`);
                        continue;
                    }
                    processedIds.add(id);

                    // ✅ Check if product already exists in DB
                    const existing = await Repository.getProduct(id, platform);
                    
                    // ✅ Chỉ skip nếu đã có URL hợp lệ (không phải trang chủ hoặc lỗi)
                    const isInvalidEntry = !existing || !existing.final_url || 
                                          existing.final_url === `https://${platform}/` || 
                                          existing.final_url === `https://${platform}` ||
                                          existing.note?.includes('Error');

                    if (existing && !isInvalidEntry) {
                        console.log(` ⏩ [${workerId}] Skip existing in DB: ${id}`);
                        results.success++; 
                        
                        if (onProgress) {
                            onProgress({
                                id, count: currentCount, total: uniqueIds.length,
                                result: existing, success: true, workerId,
                                skipped: true
                            });
                        }
                        continue;
                    }

                    console.log(`[Worker ${workerId}] Crawling ${id}...`);
                    const result = await crawlProduct(page, id, platform);

                    if (result.success) {
                        results.success++;
                        console.log(` ✅ [${workerId}] ${id} -> ${result.data.final_url}`);
                    } else {
                        results.error++;
                        console.log(` ❌ [${workerId}] ${id} -> ${result.error}`);
                    }

                    results.data.push(result.data);

                    // ✅ Batch DB writes
                    dbBatchBuffer.push(result.data);

                    if (dbBatchBuffer.length >= CONFIG.DB_BATCH_SIZE) {
                        await flushDBBatch(dbBatchBuffer);
                        dbBatchBuffer = [];
                    }

                    if (onProgress) {
                        onProgress({
                            id,
                            count: currentCount,
                            total: uniqueIds.length,
                            result: result.data,
                            success: result.success,
                            workerId
                        });
                    }

                    // ✅ Giảm stagger
                    await new Promise(resolve => setTimeout(resolve, CONFIG.STAGGER_DELAY));
                }
            } finally {
                await page.close();
            }
        };

        // ✅ Start workers - Tăng số lượng
        const workerCount = Math.min(CONFIG.CONCURRENCY, ids.length);
        const workers = Array.from({ length: workerCount }, (_, i) => worker(i + 1));

        await Promise.all(workers);

        // ✅ Flush remaining DB batch
        if (dbBatchBuffer.length > 0) {
            await flushDBBatch(dbBatchBuffer);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const rate = (uniqueIds.length / duration).toFixed(2);

        console.log(`\n✅ Completed in ${duration}s (${rate} products/sec)`);
        console.log(`   Processed: ${uniqueIds.length}, Success: ${results.success}, Errors: ${results.error}`);

    } catch (err) {
        console.error('Fatal browser error:', err);
    } finally {
        if (browser) await browser.close();
    }

    return results;
}

/**
 * ✅ Batch DB writes
 */
async function flushDBBatch(batch) {
    if (batch.length === 0) return;

    try {
        // Nếu Repository có method batch insert
        if (Repository.batchUpsertProducts) {
            await Repository.batchUpsertProducts(batch);
        } else {
            // Fallback: Sequential writes (still better than blocking each time)
            await Promise.all(batch.map(data =>
                Repository.upsertProduct(data).catch(err => {
                    console.error(`DB Error for ${data.product_id}:`, err.message);
                })
            ));
        }
        console.log(`  💾 Saved ${batch.length} products to DB`);
    } catch (err) {
        console.error('Batch DB write error:', err);
    }
}

// ============================================================
// CLI
// ============================================================
if (require.main === module) {
    const args = process.argv.slice(2);
    const platform = args.find(a => a.includes('meear')) ? PLATFORMS.MEEAR : PLATFORMS.PRINTERVAL;

    runCrawlerOptimized(DEFAULT_IDS, platform)
        .then((results) => {
            console.log('\n📊 Final Results:', results);
            process.exit(0);
        })
        .catch(err => {
            console.error('Fatal crawler error:', err);
            process.exit(1);
        });
}

module.exports = { runCrawlerOptimized, runCrawler: runCrawlerOptimized };