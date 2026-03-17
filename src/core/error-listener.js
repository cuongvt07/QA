/**
 * Error Listener Module
 * Attaches to Playwright page to capture JS errors, console errors, and network failures.
 */

class ErrorListener {
    constructor() {
        this.jsErrors = [];
        this.networkErrors = [];
        this.consoleErrors = [];

        // Fatal flags
        this.fatalApiError = false;
        this.fatalApiDetails = [];
    }

    /**
     * Attach all listeners to a Playwright page instance
     */
    attachToPage(page) {
        page.on('pageerror', (error) => {
            this.jsErrors.push({
                type: 'JS_RUNTIME_ERROR',
                message: error.message,
                stack: error.stack || '',
                timestamp: new Date().toISOString(),
            });
        });

        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                this.consoleErrors.push({
                    type: 'CONSOLE_ERROR',
                    message: msg.text(),
                    timestamp: new Date().toISOString(),
                });
            }
        });

        page.on('requestfailed', (request) => {
            const url = request.url();
            const failureReason = request.failure()?.errorText || 'Unknown';
            this.networkErrors.push({
                type: 'NETWORK_ERROR',
                url: url,
                method: request.method(),
                failure: failureReason,
                timestamp: new Date().toISOString(),
            });

            // Only mark as fatal if it's a critical API request, NOT a static asset (font, css, img)
            if (url.includes('customily')) {
                const isStaticAsset = /\.(png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|otf|css|js)(\?.*)?$/i.test(url);
                if (!isStaticAsset) {
                    this.fatalApiError = true;
                    this.fatalApiDetails.push(`Request failed: ${url} (${failureReason})`);
                }
            }
        });

        page.on('response', (response) => {
            const status = response.status();
            const url = response.url();
            if (status >= 400) {
                const isRelevant = this.isRelevantApiUrl(url);
                if (isRelevant) {
                    this.networkErrors.push({
                        type: 'NETWORK_ERROR',
                        url: url,
                        status: status,
                        statusText: response.statusText(),
                        timestamp: new Date().toISOString(),
                    });
                }

                if (url.includes('customily')) {
                    const isStaticAsset = /\.(png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|otf|css|js)(\?.*)?$/i.test(url);
                    if (!isStaticAsset) {
                        this.fatalApiError = true;
                        this.fatalApiDetails.push(`API Error ${status}: ${url}`);
                    }
                }
            }
        });
    }

    /**
     * Check if a URL is relevant to preview/customization APIs
     */
    isRelevantApiUrl(url) {
        const keywords = ['preview', 'custom', 'design', 'render', 'generate', 'template', 'personali'];
        return keywords.some((kw) => url.toLowerCase().includes(kw));
    }

    /**
     * Get summary of all captured errors
     */
    getSummary() {
        return {
            jsErrors: this.jsErrors,
            consoleErrors: this.consoleErrors,
            networkErrors: this.networkErrors,
            totalJsErrors: this.jsErrors.length,
            totalNetworkErrors: this.networkErrors.length,
            totalConsoleErrors: this.consoleErrors.length,
        };
    }

    /**
     * Return fatal status for core APIs (Customily)
     */
    getFatalApiStatus() {
        return {
            isFatal: this.fatalApiError,
            reasons: this.fatalApiDetails,
        };
    }

    /**
     * Check if any critical errors were captured
     */
    hasCriticalErrors() {
        return this.jsErrors.length > 0 || this.networkErrors.length > 0;
    }

    /**
     * Reset all captured errors
     */
    reset() {
        this.jsErrors = [];
        this.networkErrors = [];
        this.consoleErrors = [];
        this.fatalApiError = false;
        this.fatalApiDetails = [];
    }
}

module.exports = ErrorListener;
