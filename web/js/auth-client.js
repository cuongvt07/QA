/**
 * QA Engine Auth Client
 */
const Auth = {
    getToken() {
        return localStorage.getItem('qa_token');
    },

    getUser() {
        const user = localStorage.getItem('qa_user');
        return user ? JSON.parse(user) : null;
    },

    setSession(token, user) {
        localStorage.setItem('qa_token', token);
        localStorage.setItem('qa_user', JSON.stringify(user));
    },

    async logout() {
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch (e) {}
        localStorage.removeItem('qa_token');
        localStorage.removeItem('qa_user');
        window.location.href = '/login.html';
    },

    isAuthenticated() {
        return !!this.getToken();
    },

    isAdmin() {
        const user = this.getUser();
        return user && user.role === 'ADMIN';
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
            console.warn('[AUTH] Unauthorized access. Redirecting to login...');
            this.logout();
            return null;
        }

        return response;
    },

    /**
     * Check session validity on init
     */
    async checkSession() {
        if (!this.isAuthenticated()) {
            if (window.location.pathname !== '/login.html') {
                window.location.href = '/login.html';
            }
            return false;
        }

        try {
            const res = await this.fetch('/api/me');
            if (!res || !res.ok) {
                this.logout();
                return false;
            }
            const data = await res.json();
            this.setSession(this.getToken(), data.user); // Refresh user data
            return true;
        } catch (err) {
            console.error('[AUTH] Session check failed:', err);
            return false;
        }
    }
};

// Auto-check session on protected pages
if (window.location.pathname !== '/login.html') {
    Auth.checkSession();
}
