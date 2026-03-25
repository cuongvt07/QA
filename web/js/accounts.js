/**
 * QA Engine - Accounts Management Controller
 */
const Accounts = {
    users: [],

    init() {
        console.log('[ACCOUNTS] Initializing...');
        this.fetchUsers();
        this.attachEvents();
    },

    async fetchUsers() {
        try {
            const res = await Auth.fetch('/api/users');
            if (!res || !res.ok) return;
            this.users = await res.json();
            this.render();
        } catch (err) {
            console.error('[ACCOUNTS] Failed to fetch users:', err);
        }
    },

    attachEvents() {
        const btnAdd = document.getElementById('btn-add-user');
        if (btnAdd) {
            btnAdd.onclick = () => this.showModal();
        }

        const modal = document.getElementById('modal-user');
        if (modal) {
            modal.onclick = (e) => {
                if (e.target === modal) this.closeModal();
            };
        }

        const form = document.getElementById('user-form');
        if (form) {
            form.onsubmit = (e) => {
                e.preventDefault();
                this.saveUser();
            };
        }

        document.getElementById('btn-close-user-modal').onclick = () => this.closeModal();
        document.getElementById('btn-cancel-user-modal').onclick = () => this.closeModal();
    },

    render() {
        const tbody = document.getElementById('users-tbody');
        if (!tbody) return;

        if (this.users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--text-muted);">No users found.</td></tr>';
            return;
        }

        tbody.innerHTML = this.users.map(user => `
            <tr style="border-bottom: 1px solid var(--border-subtle);">
                <td style="padding: 12px 16px;">${user.email}</td>
                <td style="padding: 12px 16px;"><span class="badge ${user.role === 'ADMIN' ? 'badge-pass' : 'badge-running'}">${user.role}</span></td>
                <td style="padding: 12px 16px;">${new Date(user.created_at).toLocaleDateString()}</td>
                <td style="padding: 12px 16px;">
                    <button class="btn-ghost btn-sm" onclick="Accounts.editUser('${user.id}')" style="margin-right:8px;">Edit</button>
                    ${user.id !== Auth.getUser()?.id ? `<button class="btn-ghost btn-sm" onclick="Accounts.deleteUser('${user.id}')" style="color:var(--accent-danger);">Delete</button>` : ''}
                </td>
            </tr>
        `).join('');
    },

    showModal(user = null) {
        const modal = document.getElementById('modal-user');
        const title = document.getElementById('user-modal-title');
        const form = document.getElementById('user-form');
        
        form.reset();
        document.getElementById('user-id').value = user ? user.id : '';
        document.getElementById('user-email').value = user ? user.email : '';
        document.getElementById('user-email').disabled = !!user;
        document.getElementById('user-password').required = !user;
        document.getElementById('user-password-hint').style.display = user ? 'block' : 'none';
        document.getElementById('user-role').value = user ? user.role : 'USER';
        
        title.textContent = user ? 'Edit User' : 'Add New User';
        modal.style.display = 'flex';
    },

    closeModal() {
        document.getElementById('modal-user').style.display = 'none';
    },

    editUser(id) {
        const user = this.users.find(u => u.id === id);
        if (user) this.showModal(user);
    },

    async saveUser() {
        const id = document.getElementById('user-id').value;
        const email = document.getElementById('user-email').value;
        const password = document.getElementById('user-password').value;
        const role = document.getElementById('user-role').value;

        const isEdit = !!id;
        const url = isEdit ? `/api/users/${id}` : '/api/users';
        const method = isEdit ? 'PUT' : 'POST';
        
        const body = { role };
        if (password) body.password = password;
        if (!isEdit) body.email = email;

        try {
            const res = await Auth.fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (res && res.ok) {
                this.closeModal();
                this.fetchUsers();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to save user');
            }
        } catch (err) {
            console.error('[ACCOUNTS] Error saving user:', err);
        }
    },

    async deleteUser(id) {
        if (!confirm('Are you sure you want to delete this user?')) return;

        try {
            const res = await Auth.fetch(`/api/users/${id}`, { method: 'DELETE' });
            if (res && res.ok) {
                this.fetchUsers();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to delete user');
            }
        } catch (err) {
            console.error('[ACCOUNTS] Error deleting user:', err);
        }
    }
};
