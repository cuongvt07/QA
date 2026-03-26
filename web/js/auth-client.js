/**
 * QA Engine Auth Client
 */
const Auth = {
    getToken() {
        return 'MOCK_TOKEN'; // Always return a dummy token
    },

    getUser() {
        return { id: 'USER_MOCK', email: 'admin@megaads.com', role: 'ADMIN' };
    },

    setSession(token, user) {
        // No-op
    },

    async logout() {
        window.location.href = '/login.html';
    },

    isAuthenticated() {
        return true; // Always authenticated
    },

    isAdmin() {
        return true; // Always admin
    },

    /**
     * Wrapped fetch that adds the Authorization header
     */
    async fetch(url, options = {}) {
        const token = this.getToken();
        const headers = options.headers || {};
        
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, {
            ...options,
            headers
        });

        if (response.status === 401) {
            console.warn('[AUTH] Unauthorized access (Unexpected since auth is disabled)');
            return response;
        }

        return response;
    },

    /**
     * Check session validity on init - DISABLED
     */
    async checkSession() {
        return true;
    }
};

// Auto-check session disabled
