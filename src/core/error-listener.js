/**
 * Error Listener Module
 * Attaches to Playwright page to capture JS errors, console errors, and network failures.
 */

class ErrorListener {
    constructor() {
        this.jsErrors = [];
        this.networkErrors = [];
        this.consoleErrors = [];
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
            this.networkErrors.push({
                type: 'NETWORK_ERROR',
                url: request.url(),
                method: request.method(),
                failure: request.failure()?.errorText || 'Unknown',
                timestamp: new Date().toISOString(),
            });
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
    }
}

module.exports = ErrorListener;
